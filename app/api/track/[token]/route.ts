import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { TRANSPARENT_GIF } from "@/lib/read-receipt";
import {
  classifyOpen,
  countDistinctReads,
  extractClientIp,
  type OpenClassification,
} from "@/lib/read-receipt-classify";
import { createServiceRoleClient } from "@/lib/supabase";

// Response headers required to prevent ANY proxy/CDN caching the pixel.
// Without no-store, a recipient who opens an email twice only shows the
// first open — every subsequent open is served from cache and never
// reaches this endpoint.
const PIXEL_HEADERS: HeadersInit = {
  "Content-Type": "image/gif",
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "User-Agent, Accept",
  "X-Content-Type-Options": "nosniff",
};

async function handle(req: NextRequest, token: string): Promise<NextResponse> {
  const ua = req.headers.get("user-agent") ?? "";
  const ip = extractClientIp(req.headers);
  const method = req.method;
  const now = new Date();

  // Return the pixel IMMEDIATELY. All classification and DB work runs in
  // after() so the image response is never blocked by logging or classification.
  after(async () => {
    try {
      const supabase = createServiceRoleClient();

      const { data: receipt } = await supabase
        .from("read_receipts")
        .select("token, sent_at, sender_ip, sender_user_agent, opened_at")
        .eq("token", token)
        .maybeSingle();

      if (!receipt) {
        // Unknown token — don't tip off clients but also don't log.
        return;
      }

      const { data: priorHits } = await supabase
        .from("email_opens")
        .select("opened_at, classification, is_real_open")
        .eq("token", token)
        .order("opened_at", { ascending: true });

      const classification = classifyOpen({
        now,
        sentAt: receipt.sent_at ? new Date(receipt.sent_at) : null,
        senderIp: receipt.sender_ip,
        senderUa: receipt.sender_user_agent,
        ip,
        ua,
        method,
        priorHits: priorHits ?? [],
      });

      // Always insert — even filtered hits are stored so classification can
      // be audited / tuned later.
      await supabase.from("email_opens").insert({
        token,
        opened_at: now.toISOString(),
        ip_address: ip || null,
        user_agent: ua || null,
        is_real_open: classification.isRealOpen,
        classification: classification.classification satisfies OpenClassification,
      });

      // Mirror the first real open onto read_receipts.opened_at for fast
      // Sent-view display. countDistinctReads handles 30s dedup.
      if (classification.isRealOpen && !receipt.opened_at) {
        const allHits = [
          ...(priorHits ?? []),
          {
            opened_at: now.toISOString(),
            classification: classification.classification,
            is_real_open: classification.isRealOpen,
          },
        ];
        // Fetch ip/ua for dedup
        const { data: hitsWithIp } = await supabase
          .from("email_opens")
          .select("opened_at, ip_address, user_agent, is_real_open")
          .eq("token", token);
        const hitsForCount = [
          ...(hitsWithIp ?? []),
          {
            opened_at: now.toISOString(),
            ip_address: ip || null,
            user_agent: ua || null,
            is_real_open: classification.isRealOpen,
          },
        ];
        const { firstOpenedAt } = countDistinctReads(hitsForCount);
        if (firstOpenedAt) {
          await supabase
            .from("read_receipts")
            .update({ opened_at: firstOpenedAt })
            .eq("token", token)
            .is("opened_at", null);
        }
        // avoid unused-warning — allHits was kept for clarity only
        void allHits;
      }
    } catch (err) {
      console.error("[track] classification failed:", err);
    }
  });

  return new NextResponse(TRANSPARENT_GIF, { headers: PIXEL_HEADERS });
}

/**
 * GET /api/track/[token]
 * Returns 200 + 1x1 GIF immediately. Classification and persistence run
 * after the response is sent (Next.js after() hook).
 *
 * ALWAYS returns 200 — never 204, 404, or an error. Returning error codes
 * tips off clients and can cause broken-image icons in some mail clients.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  return handle(req, token);
}

/**
 * HEAD /api/track/[token]
 * Security scanners often HEAD-probe URLs before retrieving them.
 * We respond the same way (so the probe appears to succeed) but the
 * classifier tags the hit as security_scanner and does not count it.
 */
export async function HEAD(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  return handle(req, token);
}
