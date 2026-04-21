import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { sendEmail, fetchMessageIdHeader } from "@/lib/gmail";
import { extractSenderContext } from "@/lib/read-receipt";
import { insertReceipt, updateReceipt } from "@/lib/read-receipt-db";

const sendSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  sendAt: z.string().datetime().optional(),
  // Reply threading
  replyToMessageId: z.string().optional(), // Gmail message ID of the email being replied to
  replyThreadId: z.string().optional(),    // Gmail thread ID
});

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId: string;
};

/**
 * POST /api/send
 * Send immediately or schedule for later.
 * Injects read receipt tracking pixel for immediate sends.
 */
export async function POST(req: NextRequest) {
  const rawSession = await auth();
  if (!rawSession) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = rawSession as unknown as ExtendedSession;
  const { accessToken } = session;
  const userId =
    (session.userId as string | undefined) ?? emailToUserId(session.user.email);

  const parsed = sendSchema.safeParse(await req.json());
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    const msg = Object.entries(fields).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`).join("; ");
    return NextResponse.json({ error: msg || "Invalid request" }, { status: 400 });
  }

  const { to, subject, body: emailBody, sendAt, replyToMessageId, replyThreadId } = parsed.data;
  const supabase = createServiceRoleClient();

  if (sendAt) {
    const { error } = await supabase
      .from("scheduled_sends")
      .insert({ user_id: userId, to_email: to, subject, body: emailBody, send_at: sendAt, sent: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ scheduled: true, sendAt });
  }

  // Immediate send: generate tracking token, insert read receipt, send
  const trackingToken = crypto.randomUUID();
  const { senderIp, senderUa } = extractSenderContext(req.headers);
  const sentAt = new Date().toISOString();

  const { error: receiptError } = await insertReceipt(supabase, {
    token: trackingToken,
    user_id: userId,
    email_message_id: "", // updated post-send with real message id
    recipient_email: to,
    opened_at: null,
    sent_at: sentAt,
    sender_ip: senderIp || null,
    sender_user_agent: senderUa || null,
  });

  if (receiptError) {
    console.error("Read receipt insert error:", receiptError);
    // Non-fatal — continue with send
  }

  // If replying, fetch the RFC 2822 Message-ID header for proper threading
  let inReplyTo: string | undefined;
  if (replyToMessageId) {
    try {
      inReplyTo = await fetchMessageIdHeader(accessToken, replyToMessageId);
    } catch (err) {
      console.error("Failed to fetch Message-ID header:", err);
    }
  }

  const sentMessageId = await sendEmail(accessToken, {
    to,
    subject,
    body: emailBody,
    trackingToken,
    replyThreadId,
    inReplyTo,
    references: inReplyTo,
  });

  // Update read receipt with the real sent message ID
  await updateReceipt(supabase, trackingToken, { email_message_id: sentMessageId });

  return NextResponse.json({ sent: true, messageId: sentMessageId });
}
