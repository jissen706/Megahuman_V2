import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { getDraft, sendDraft } from "@/lib/gmail";
import { extractSenderContext } from "@/lib/read-receipt";
import { insertReceipt, updateReceipt } from "@/lib/read-receipt-db";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId?: string;
};

/**
 * POST /api/gmail/drafts/[id]/send
 * Sends an existing draft and keeps the read-receipt row in sync.
 *
 * If the draft was created via create_batch_drafts (or the compose flow)
 * there is already a receipt row keyed on the DRAFT's internal message id
 * with a tracking pixel token embedded in the body. After send, Gmail
 * assigns a new message id for the SENT message, so we migrate the row
 * to the new id. If no pre-existing row is found we insert a fresh
 * "Not opened" placeholder so the Sent view still lists the send.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const extSession = session as unknown as ExtendedSession;
  const { accessToken } = extSession;
  const userId = extSession.userId ?? emailToUserId(extSession.user.email);
  const { id } = await ctx.params;

  const { senderIp, senderUa } = extractSenderContext(req.headers);
  const sentAtIso = new Date().toISOString();

  try {
    // Peek to capture the draft's current messageId before it ships.
    const draft = await getDraft(accessToken, id);
    const preSendMessageId = draft.messageId;

    const sentMessageId = await sendDraft(accessToken, id);

    const supabase = createServiceRoleClient();
    const { data: existing } = await supabase
      .from("read_receipts")
      .select("token")
      .eq("user_id", userId)
      .eq("email_message_id", preSendMessageId)
      .maybeSingle();

    if (existing?.token) {
      // Migrate the existing row to the newly-assigned sent message id and
      // stamp the real send time / sender fingerprint captured from THIS
      // request (which may differ from draft-create time if the user is
      // on a different device).
      await updateReceipt(supabase, existing.token, {
        email_message_id: sentMessageId,
        recipient_email: draft.to,
        sent_at: sentAtIso,
        sender_ip: senderIp || null,
        sender_user_agent: senderUa || null,
      });
    } else {
      // Draft was created outside the MegaHuman flow (no pixel injected).
      // Insert a placeholder so Sent view still shows the send; tracking
      // is not possible because there's no pixel URL in the body.
      await insertReceipt(supabase, {
        token: crypto.randomUUID(),
        user_id: userId,
        email_message_id: sentMessageId,
        recipient_email: draft.to,
        opened_at: null,
        sent_at: sentAtIso,
        sender_ip: senderIp || null,
        sender_user_agent: senderUa || null,
      });
    }

    return NextResponse.json({ ok: true, messageId: sentMessageId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send draft" },
      { status: 500 }
    );
  }
}
