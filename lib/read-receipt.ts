// 43-byte minimal transparent 1x1 GIF89a.
// Hardcoded bytes so it never changes and cache-busting is entirely URL-based.
export const TRANSPARENT_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

/**
 * Extract sender IP + UA from an incoming send request.
 * Stored on the receipt row at send time so subsequent pixel hits from the
 * same fingerprint can be filtered as sender_self_open (they happen when
 * Gmail loads the sender's own Sent copy in another tab).
 */
export function extractSenderContext(headers: Headers): {
  senderIp: string;
  senderUa: string;
} {
  const xff = headers.get("x-forwarded-for");
  const xri = headers.get("x-real-ip");
  const senderIp =
    xff?.split(",")[0]?.trim() || xri || "";
  const senderUa = headers.get("user-agent") ?? "";
  return { senderIp, senderUa };
}

/**
 * Return the best available public base URL for constructing the tracking
 * pixel src. Falls back to NEXTAUTH_URL if NEXT_PUBLIC_APP_URL isn't set.
 * Strips any trailing slash.
 */
export function getPublicBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    "";
  return raw.replace(/\/$/, "");
}

let warnedLocalhost = false;

/**
 * Build the tracking pixel HTML to inject into outgoing email body.
 * Logs a one-time warning if the public base URL is localhost — in that case
 * no recipient mail client can reach the pixel, so read receipts silently
 * never fire.
 */
export function buildTrackingPixel(token: string): string {
  const appUrl = getPublicBaseUrl();
  if (!warnedLocalhost && /localhost|127\.0\.0\.1/i.test(appUrl)) {
    warnedLocalhost = true;
    console.warn(
      `[read-receipt] NEXT_PUBLIC_APP_URL is "${appUrl}". ` +
        `Recipients cannot reach localhost — read receipts will never fire. ` +
        `Expose this app publicly (e.g. ngrok) and set NEXT_PUBLIC_APP_URL to the public URL.`
    );
  }
  return `<img src="${appUrl}/api/track/${token}" width="1" height="1" style="display:none;border:0;" alt="" />`;
}

/**
 * Format relative time string for display (e.g. "Opened 5 mins ago")
 */
export function formatOpenedAt(openedAt: string | null): string {
  if (!openedAt) return "Not opened";
  const diff = Date.now() - new Date(openedAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Opened just now";
  if (mins < 60) return `Opened ${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Opened ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Opened ${days}d ago`;
}
