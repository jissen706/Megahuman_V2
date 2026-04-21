import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { TRANSPARENT_GIF } from "@/lib/read-receipt";
import {
  classifyOpen,
  extractClientIp,
  type OpenClassification,
} from "@/lib/read-receipt-classify";
import { createServiceRoleClient } from "@/lib/supabase";
import { recordOpen, selectOpens, selectReceipt } from "@/lib/read-receipt-db";

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

      const receipt = await selectReceipt(supabase, token);
      if (!receipt) {
        // Unknown token — don't tip off clients but also don't log.
        return;
      }

      const { hits: priorHits } = await selectOpens(supabase, token);

      const classification = classifyOpen({
        now,
        sentAt: receipt.sent_at ? new Date(receipt.sent_at) : null,
        senderIp: receipt.sender_ip,
        senderUa: receipt.sender_user_agent,
        ip,
        ua,
        method,
        priorHits: priorHits.map((h) => ({
          opened_at: h.opened_at,
          classification: h.classification,
          is_real_open: h.is_real_open,
        })),
      });

      // recordOpen inserts into email_opens when available, otherwise
      // updates read_receipts.opened_at directly (legacy mode).
      await recordOpen(supabase, {
        token,
        opened_at: now.toISOString(),
        ip_address: ip || null,
        user_agent: ua || null,
        is_real_open: classification.isRealOpen,
        classification: classification.classification satisfies OpenClassification,
      });

      // On the first real open, also stamp read_receipts.opened_at so the
      // Sent view's fast-path query sees it without having to roll up
      // email_opens. (recordOpen already does this in legacy mode.)
      if (classification.isRealOpen && !receipt.opened_at) {
        await supabase
          .from("read_receipts")
          .update({ opened_at: now.toISOString() })
          .eq("token", token)
          .is("opened_at", null);
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
