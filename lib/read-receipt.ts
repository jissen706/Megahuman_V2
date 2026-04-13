// 1x1 transparent GIF (base64)
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/**
 * Build the tracking pixel HTML to inject into outgoing email body.
 */
export function buildTrackingPixel(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
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
