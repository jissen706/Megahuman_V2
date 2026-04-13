import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { fetchInboxByCategory, fetchSentMessages } from "@/lib/gmail";
import { extractVoiceProfile, bestPlainText } from "@/lib/voice-profile";
import { sendEmail } from "@/lib/gmail";

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

  const [inboxMessages, sentMessages] = await Promise.all([
    fetchInboxByCategory(accessToken, 100, toEpochSec(latestInboxRow)),
    fetchSentMessages(accessToken, 100, toEpochSec(latestSentRow)),
  ]);

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
    triage_label: "triageLabel" in m ? m.triageLabel : null,
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

  // Process any scheduled sends that are now due
  const { data: dueSends } = await db
    .from("scheduled_sends")
    .select("*")
    .eq("user_id", userId)
    .eq("sent", false)
    .lte("send_at", new Date().toISOString());

  for (const row of dueSends ?? []) {
    try {
      const trackingToken = crypto.randomUUID();
      await db.from("read_receipts").insert({
        token: trackingToken,
        user_id: userId,
        email_message_id: "",
        recipient_email: row.to_email,
        opened_at: null,
      });

      const sentMessageId = await sendEmail(accessToken, {
        to: row.to_email,
        subject: row.subject,
        body: row.body,
        trackingToken,
      });

      await Promise.all([
        db.from("read_receipts")
          .update({ email_message_id: sentMessageId })
          .eq("token", trackingToken),
        db.from("scheduled_sends")
          .update({ sent: true })
          .eq("id", row.id),
      ]);
    } catch (err) {
      console.error("Scheduled send failed:", row.id, err);
    }
  }

  return NextResponse.json({ synced: allMessages.length, voiceProfileUpdated });
}
