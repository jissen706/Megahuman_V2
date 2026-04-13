import { redirect } from "next/navigation";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import SentList from "@/components/inbox/SentList";
import { type Email } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  userId: string;
};

interface SentEmail extends Email {
  opened_at?: string | null;
}

/**
 * Sent mail view with read receipt status.
 */
export default async function SentPage() {
  let rawSession;
  try {
    rawSession = await auth();
  } catch {
    redirect("/api/auth/signin");
  }
  if (!rawSession?.user?.email) redirect("/api/auth/signin");
  const session = rawSession as unknown as ExtendedSession;
  const userId =
    (session.userId as string | undefined) ?? emailToUserId(session.user.email);

  const supabase = createServiceRoleClient();

  // Fetch sent emails
  const { data: sentEmails, error: sentError } = await supabase
    .from("emails")
    .select("id,thread_id,user_id,from_email,to_email,subject,snippet,body_plain,body_html,is_archived,received_at,is_sent,is_read,triage_label,snoozed_until,follow_up_at,attachments")
    .eq("user_id", userId)
    .eq("is_sent", true)
    .order("received_at", { ascending: false });

  if (sentError) console.error("Sent fetch error:", sentError);

  const emails = sentEmails ?? [];
  if (emails.length === 0) {
    return (
      <main className="flex h-screen flex-col">
        <SentList emails={[]} />
      </main>
    );
  }

  // Fetch read receipts for these emails
  const emailIds = emails.map((e) => e.id);
  const { data: receipts } = await supabase
    .from("read_receipts")
    .select("email_message_id, opened_at")
    .in("email_message_id", emailIds);

  const receiptMap = new Map<string, string | null>(
    (receipts ?? []).map((r) => [r.email_message_id, r.opened_at])
  );

  const sentEmailsWithReceipts: SentEmail[] = emails.map((email) => ({
    ...email,
    opened_at: receiptMap.get(email.id) ?? null,
  }));

  return (
    <main className="flex h-screen flex-col">
      <SentList emails={sentEmailsWithReceipts} />
    </main>
  );
}
