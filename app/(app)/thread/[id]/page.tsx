import { redirect } from "next/navigation";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { fetchGmailThread } from "@/lib/gmail";
import ThreadView from "@/components/thread/ThreadView";
import { type Email } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId: string;
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ThreadPage({ params }: Props) {
  const { id } = await params;

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

  // Fetch full thread from Gmail API so we always see all messages, including replies
  let gmailMessages: Email[] = [];
  try {
    const msgs = await fetchGmailThread(session.accessToken, id);
    gmailMessages = msgs.map((m) => ({
      id: m.id,
      user_id: userId,
      thread_id: m.threadId,
      from_email: m.from,
      subject: m.subject,
      snippet: m.snippet,
      body_plain: m.bodyPlain,
      body_html: m.bodyHtml,
      attachments: m.attachments,
      received_at: m.receivedAt.toISOString(),
      to_email: null,
      is_sent: m.isSent,
      is_read: true,
      is_archived: false,
      triage_label: null,
      snoozed_until: null,
      follow_up_at: null,
    }));
  } catch (err) {
    console.error("Gmail thread fetch error:", err);
  }

  // Mark unread in DB (fire-and-forget)
  const supabase = createServiceRoleClient();
  supabase
    .from("emails")
    .update({ is_read: true })
    .eq("user_id", userId)
    .eq("thread_id", id)
    .eq("is_sent", false)
    .eq("is_read", false)
    .then(({ error }) => { if (error) console.error("Mark read error:", error); });

  return (
    <main className="flex h-screen flex-col">
      <ThreadView threadId={id} messages={gmailMessages} />
    </main>
  );
}
