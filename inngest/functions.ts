import { inngest } from "@/lib/inngest";
import { structuredOutput } from "@/lib/claude";
import { createServiceRoleClient, type TriageLabel } from "@/lib/supabase";
import { sendEmail } from "@/lib/gmail";

/**
 * Triggered after Gmail sync — classifies new emails and stores triage labels.
 */
export const triageEmails = inngest.createFunction(
  {
    id: "triage-emails",
    triggers: [{ event: "email/triage.requested" }],
  },
  async ({ event }: { event: { data: { userId: string; emailIds: string[] } } }) => {
    const { userId, emailIds } = event.data;
    if (emailIds.length === 0) return { triaged: 0 };

    const supabase = createServiceRoleClient();

    // Fetch email metadata for the given IDs
    const { data: emails, error } = await supabase
      .from("emails")
      .select("id, from_email, subject, snippet")
      .eq("user_id", userId)
      .in("id", emailIds)
      .is("triage_label", null); // skip already-triaged emails

    if (error || !emails?.length) return { triaged: 0 };

    const TRIAGE_SYSTEM = `You are an email triage assistant. Classify each email into exactly one category:
- urgent: needs immediate attention, time-sensitive, from someone important
- needs_reply: requires a response but not urgent
- fyi: informational, no action needed
- newsletter: marketing, newsletters, automated emails, subscriptions`;

    const prompt = `Classify each of these emails. Return a JSON array with one entry per email.

${emails
  .map(
    (e, i) => `[${i + 1}] id="${e.id}"
From: ${e.from_email}
Subject: ${e.subject}
Preview: ${e.snippet}`
  )
  .join("\n\n")}`;

    type Classification = { id: string; label: TriageLabel };
    type Result = { classifications: Classification[] };

    const result = await structuredOutput<Result>({
      system: TRIAGE_SYSTEM,
      prompt,
      toolName: "classify_emails",
      toolDescription: "Classify a list of emails by triage label",
      inputSchema: {
        properties: {
          classifications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: {
                  type: "string",
                  enum: ["urgent", "needs_reply", "fyi", "newsletter"],
                },
              },
              required: ["id", "label"],
            },
          },
        },
        required: ["classifications"],
      },
      maxTokens: 1024,
    });

    // Upsert triage labels
    await Promise.all(
      result.classifications.map(({ id, label }) =>
        supabase.from("emails").update({ triage_label: label }).eq("id", id)
      )
    );

    return { triaged: result.classifications.length };
  }
);

/**
 * Sends a scheduled email at the specified time.
 */
export const sendScheduledEmail = inngest.createFunction(
  {
    id: "send-scheduled-email",
    triggers: [{ event: "email/send.scheduled" }],
  },
  async ({ event }: { event: { data: { scheduledSendId: string } } }) => {
    const { scheduledSendId } = event.data;
    const supabase = createServiceRoleClient();

    const { data: scheduled, error: fetchError } = await supabase
      .from("scheduled_sends")
      .select("*")
      .eq("id", scheduledSendId)
      .eq("sent", false)
      .single();

    if (fetchError || !scheduled) {
      throw new Error(`Scheduled send not found: ${scheduledSendId}`);
    }

    const { data: tokenRow, error: tokenError } = await supabase
      .from("user_tokens")
      .select("access_token")
      .eq("user_id", scheduled.user_id)
      .single();

    if (tokenError || !tokenRow) {
      throw new Error(`No access token found for user ${scheduled.user_id}`);
    }

    const trackingToken = crypto.randomUUID();

    await supabase.from("read_receipts").insert({
      token: trackingToken,
      user_id: scheduled.user_id,
      email_message_id: "",
      recipient_email: scheduled.to_email,
      opened_at: null,
    });

    const sentMessageId = await sendEmail(tokenRow.access_token, {
      to: scheduled.to_email,
      subject: scheduled.subject,
      body: scheduled.body,
      trackingToken,
    });

    await Promise.all([
      supabase
        .from("read_receipts")
        .update({ email_message_id: sentMessageId })
        .eq("token", trackingToken),
      supabase
        .from("scheduled_sends")
        .update({ sent: true })
        .eq("id", scheduledSendId),
    ]);

    return { sent: scheduledSendId, messageId: sentMessageId };
  }
);

/**
 * Cron: runs every 15 minutes. Resurfaces snoozed emails whose time has passed.
 */
export const checkSnoozed = inngest.createFunction(
  {
    id: "check-snoozed",
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async () => {
    const supabase = createServiceRoleClient();

    const { data: snoozed } = await supabase
      .from("emails")
      .select("id")
      .lte("snoozed_until", new Date().toISOString())
      .not("snoozed_until", "is", null);

    if (!snoozed?.length) return { unsnoozed: 0 };

    await supabase
      .from("emails")
      .update({ snoozed_until: null })
      .in("id", snoozed.map((e) => e.id));

    return { unsnoozed: snoozed.length };
  }
);

/**
 * Cron: runs daily at 8am. Surfaces follow-up reminders for unanswered emails.
 */
export const checkFollowUps = inngest.createFunction(
  {
    id: "check-follow-ups",
    triggers: [{ cron: "0 8 * * *" }],
  },
  async () => {
    const supabase = createServiceRoleClient();

    const { data: dueEmails } = await supabase
      .from("emails")
      .select("id, thread_id, received_at")
      .lte("follow_up_at", new Date().toISOString())
      .not("follow_up_at", "is", null)
      .eq("is_sent", false);

    if (!dueEmails?.length) return { followedUp: 0 };

    const needsFollowUp: string[] = [];
    for (const email of dueEmails) {
      const { data: replies } = await supabase
        .from("emails")
        .select("id")
        .eq("thread_id", email.thread_id)
        .gt("received_at", email.received_at)
        .limit(1);

      if (!replies?.length) needsFollowUp.push(email.id);
    }

    if (needsFollowUp.length) {
      await supabase
        .from("emails")
        .update({ triage_label: "needs_reply", follow_up_at: null })
        .in("id", needsFollowUp);
    }

    return { followedUp: needsFollowUp.length };
  }
);
