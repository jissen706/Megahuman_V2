import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { fetchAttachment } from "@/lib/gmail";

type ExtendedSession = {
  accessToken: string;
};

/**
 * GET /api/emails/[id]/attachment/[attachmentId]
 * Proxies Gmail attachment data through our server (requires auth).
 * Used for inline images (cid: replacement) and download links.
 *
 * Query params:
 *   type     - MIME type of the attachment (e.g. image/jpeg)
 *   download - if "1", sets Content-Disposition: attachment
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const session = await auth();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { id: messageId, attachmentId } = await params;
  const { accessToken } = session as unknown as ExtendedSession;
  const mimeType = req.nextUrl.searchParams.get("type") ?? "application/octet-stream";
  const download = req.nextUrl.searchParams.get("download") === "1";

  try {
    const attachment = await fetchAttachment(accessToken, messageId, attachmentId);
    const buffer = Buffer.from(attachment.data, "base64url");

    const headers: HeadersInit = {
      "Content-Type": mimeType,
      "Cache-Control": "private, max-age=3600",
    };

    if (download) {
      headers["Content-Disposition"] = `attachment`;
    }

    return new NextResponse(buffer, { headers });
  } catch (err) {
    console.error("Attachment fetch error:", err);
    return new NextResponse("Failed to fetch attachment", { status: 502 });
  }
}
