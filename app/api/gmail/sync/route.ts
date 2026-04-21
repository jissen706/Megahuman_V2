import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { fetchInboxByCategory, fetchSentMessages } from "@/lib/gmail";
import { extractVoiceProfile, bestPlainText } from "@/lib/voice-profile";
import { sendEmail } from "@/lib/gmail";
import { insertReceipt, updateReceipt } from "@/lib/read-receipt-db";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId: string;
};

/**
 * POST /api/gmail/sync
 * Syncs inbox + sent mail into Supabase, then triages inline (no Inngest needed).
 */
export async function POST() {
  try {
  const rawSession = await auth();
  if (!rawSession) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = rawSession as unknown as ExtendedSession;
  const { accessToken } = session;
  const userId =
    (session.userId as string | undefined) ?? emailToUserId(session.user.email);

  const db = createServiceRoleClient();

  // Find the latest email per type for incremental sync
  const [{ data: latestInboxRow }, { data: latestSentRow }] = await Promise.all([
    db.from("emails").select("received_at").eq("user_id", userId).eq("is_sent", false)
      .order("received_at", { ascending: false }).limit(1).single(),
    db.from("emails").select("received_at").eq("user_id", userId).eq("is_sent", true)
      .order("received_at", { ascending: false }).limit(1).single(),
  ]);

  const toEpochSec = (row: { received_at: string } | null) =>
    row?.received_at ? Math.floor(new Date(row.received_at).getTime() / 1000) - 60 : undefined;

  let inboxMessages, sentMessages;
  try {
    [inboxMessages, sentMessages] = await Promise.all([
      fetchInboxByCategory(accessToken, 100, toEpochSec(latestInboxRow)),
      fetchSentMessages(accessToken, 100, toEpochSec(latestSentRow)),
    ]);
  } catch (gmailErr) {
    console.error("Gmail API error:", gmailErr);
    return NextResponse.json(
      { error: gmailErr instanceof Error ? gmailErr.message : "Gmail API failed" },
      { status: 502 }
    );
  }

  // Deduplicate by ID — some messages appear in both inbox and sent
  const seen = new Set<string>();
  const allMessages = [...inboxMessages, ...sentMessages].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  const rows = allMessages.map((m) => ({
    id: m.id,
    user_id: userId,
    thread_id: m.threadId,
    from_email: m.from,
    to_email: m.to || null,
    subject: m.subject,
    snippet: m.snippet,
    body_plain: m.bodyPlain,
    body_html: m.bodyHtml,
    attachments: m.attachments,
    received_at: m.receivedAt.toISOString(),
    is_sent: m.isSent,
    is_read: false,
    is_archived: false,
    triage_label: "triageLabel" in m ? (m as Record<string, unknown>).triageLabel as string : null,
  }));

  const uniqueRows = Array.from(new Map(rows.map((r) => [r.id, r])).values());

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("emails").upsert(uniqueRows, {
    onConflict: "id",
    ignoreDuplicates: false,
  });

  if (error) {
    console.error("Supabase upsert error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Prune emails beyond the 500 most recent per user
  await db.rpc("prune_emails", { p_user_id: userId, p_keep: 500 });


  // Rebuild voice profile at most once per 24h
  let voiceProfileUpdated = false;
  try {
    const { data: existing } = await db
      .from("voice_profiles")
      .select("updated_at")
      .eq("user_id", userId)
      .single();

    const lastUpdated = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
    const stale = Date.now() - lastUpdated > 24 * 60 * 60 * 1000;

    if (stale) {
      const { data: sentRows } = await db
        .from("emails")
        .select("body_plain, body_html")
        .eq("user_id", userId)
        .eq("is_sent", true)
        .order("received_at", { ascending: false })
        .limit(50);

      const bodies = (sentRows ?? []).map((r) => bestPlainText(r)).filter((b) => b.length > 0);
      const { raw } = await extractVoiceProfile(bodies);

      await db.from("voice_profiles").upsert({
        user_id: userId,
        profile_text: raw,
        updated_at: new Date().toISOString(),
      });

      voiceProfileUpdated = true;
    }
  } catch (err) {
    console.error("Voice profile extraction error:", err);
  }

  // Process any scheduled sends that are now due. Uses the same atomic
  // claim pattern as the Inngest function so both paths can run safely
  // without double-sending.
  const { data: dueSends } = await db
    .from("scheduled_sends")
    .select("*")
    .eq("user_id", userId)
    .eq("sent", false)
    .lte("send_at", new Date().toISOString());

  for (const row of dueSends ?? []) {
    // Atomic claim — only the first caller wins.
    const { data: claimed } = await db
      .from("scheduled_sends")
      .update({ sent: true })
      .eq("id", row.id)
      .eq("sent", false)
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    try {
      const trackingToken = crypto.randomUUID();
      const sentAt = new Date().toISOString();

      await insertReceipt(db, {
        token: trackingToken,
        user_id: userId,
        email_message_id: "",
        recipient_email: row.to_email,
        opened_at: null,
        sent_at: sentAt,
        sender_ip: null,
        sender_user_agent: null,
      });

      const sentMessageId = await sendEmail(accessToken, {
        to: row.to_email,
        subject: row.subject,
        body: row.body,
        trackingToken,
      });

      await updateReceipt(db, trackingToken, { email_message_id: sentMessageId });
    } catch (err) {
      console.error("Scheduled send failed:", row.id, err);
      // Release claim so another attempt can retry.
      await db.from("scheduled_sends").update({ sent: false }).eq("id", row.id);
    }
  }

  return NextResponse.json({ synced: allMessages.length, voiceProfileUpdated });
  } catch (err) {
    console.error("Sync route error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 }
    );
  }
}
