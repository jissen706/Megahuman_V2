import { redirect } from "next/navigation";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import InboxList from "@/components/inbox/InboxList";
import { type Email } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  userId: string;
};

/**
 * Main inbox view.
 * Fetches emails from Supabase server-side, renders InboxList.
 */
export default async function InboxPage() {
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
  const now = new Date().toISOString();

  const { data: emails, error } = await supabase
    .from("emails")
    .select("id,thread_id,user_id,from_email,subject,snippet,received_at,is_sent,is_read,triage_label,snoozed_until,follow_up_at,attachments")
    .eq("user_id", userId)
    .eq("is_sent", false)
    .eq("is_archived", false)
    .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
    .order("received_at", { ascending: false })
    .limit(100);

  if (error) console.error("Inbox fetch error:", error);

  return (
    <main className="flex h-screen flex-col">
      <InboxList emails={(emails ?? []) as Email[]} />
    </main>
  );
}
