import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import {
  deleteDraft,
  fetchAttachment,
  getDraft,
  plainTextToHtml,
  updateDraft,
  type DraftAttachmentInput,
} from "@/lib/gmail";
import { buildTrackingPixel } from "@/lib/read-receipt";
import { updateReceipt } from "@/lib/read-receipt-db";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId?: string;
};

const patchSchema = z.object({
  to: z.string().min(1),
  subject: z.string(),
  body: z.string(),
});

/**
 * GET /api/gmail/drafts/[id] — fetch full draft
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { accessToken } = session as unknown as ExtendedSession;
  const { id } = await ctx.params;

  try {
    const draft = await getDraft(accessToken, id);
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load draft" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/gmail/drafts/[id] — update to/subject/body
 *
 * Preserves existing attachments by re-downloading them and re-including
 * them in the new MIME message. Also keeps read-receipt tracking working
 * across edits: if a receipt row exists for this draft's underlying
 * message id, we re-inject the same tracking pixel into the new body and
 * update the row's email_message_id to match the new (post-PUT) message id.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const extSession = session as unknown as ExtendedSession;
  const { accessToken } = extSession;
  const userId = extSession.userId ?? emailToUserId(extSession.user.email);
  const { id } = await ctx.params;

  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { to, subject, body } = parsed.data;

  try {
    const existing = await getDraft(accessToken, id);

    // Preserve attachments
    const attachmentsToKeep: DraftAttachmentInput[] = await Promise.all(
      existing.attachments
        .filter((a) => !a.inline)
        .map(async (a) => {
          const data = await fetchAttachment(accessToken, existing.messageId, a.attachmentId);
          return {
            filename: a.filename,
            mimeType: a.mimeType,
            data: Buffer.from(data.data, "base64url"),
          };
        })
    );

    // Look up an existing receipt row for this draft so we can re-attach the
    // pixel using the same token after the body rewrite.
    const supabase = createServiceRoleClient();
    const { data: existingReceipt } = await supabase
      .from("read_receipts")
      .select("token")
      .eq("user_id", userId)
      .eq("email_message_id", existing.messageId)
      .is("opened_at", null)
      .maybeSingle();

    let bodyHtml = plainTextToHtml(body);
    if (existingReceipt?.token) {
      bodyHtml += buildTrackingPixel(existingReceipt.token);
    }

    const { messageId: newMessageId } = await updateDraft(accessToken, id, {
      to,
      subject,
      bodyHtml,
      attachments: attachmentsToKeep,
    });

    // Keep the receipt row pointing at the current message id so the send
    // endpoint (and Sent view join) can find it.
    if (existingReceipt?.token) {
      await updateReceipt(supabase, existingReceipt.token, {
        email_message_id: newMessageId,
        recipient_email: to,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update draft" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/gmail/drafts/[id] — discard draft
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { accessToken } = session as unknown as ExtendedSession;
  const { id } = await ctx.params;

  try {
    await deleteDraft(accessToken, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete draft" },
      { status: 500 }
    );
  }
}
