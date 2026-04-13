import { NextRequest, NextResponse } from "next/server";
import { TRANSPARENT_GIF } from "@/lib/read-receipt";
import { createServiceRoleClient } from "@/lib/supabase";

const PIXEL_HEADERS = {
  "Content-Type": "image/gif",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

/**
 * GET /api/track/[token]
 * Returns a 1x1 transparent GIF and marks the read receipt as opened.
 * Always returns 200 — never errors (avoids broken image indicators).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const ua = _req.headers.get("user-agent") ?? "";
  const isBot = /googlebot|googleimageproxy|google image proxy|bingbot|yahoo|spider|crawler|bot\b|outlook-ios|microsoft office|ms-office|apple-mail-proxy|yahoo.*slurp|yandex|mail\.ru|proxy|prefetch|preview/i.test(ua);

  try {
    if (!isBot) {
      const supabase = createServiceRoleClient();

      // Only update if token exists and hasn't been opened yet
      await supabase
        .from("read_receipts")
        .update({ opened_at: new Date().toISOString() })
        .eq("token", token)
        .is("opened_at", null);
    }
  } catch {
    // Silently ignore — always return the pixel
  }

  return new NextResponse(TRANSPARENT_GIF, { headers: PIXEL_HEADERS });
}
