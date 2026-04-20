import { redirect } from "next/navigation";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import SentList from "@/components/inbox/SentList";
import { type Email } from "@/lib/supabase";
import { countDistinctReads } from "@/lib/read-receipt-classify";

type ExtendedSession = {
  user: { email: string };
  userId: string;
};

interface SentEmail extends Email {
  opened_at?: string | null;
  open_count?: number;
  preloaded_only?: boolean; // only apple_mpp / gmail_proxy hits exist, no confirmed real open
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

  // Fetch tracking data: each sent email → receipt row (→ token → opens log).
  // We compute open_count (deduplicated by 30s window) and flag whether the
  // only hits are preloads (apple_mpp) so the UI can label "Likely opened".
  const emailIds = emails.map((e) => e.id);
  const { data: receipts } = await supabase
    .from("read_receipts")
    .select("email_message_id, token, opened_at")
    .in("email_message_id", emailIds);

  const tokens = (receipts ?? []).map((r) => r.token).filter(Boolean);
  const openQueryResult = tokens.length
    ? await supabase
        .from("email_opens")
        .select("token, opened_at, ip_address, user_agent, is_real_open, classification")
        .in("token", tokens)
    : {
        data: [] as Array<{
          token: string;
          opened_at: string;
          ip_address: string | null;
          user_agent: string | null;
          is_real_open: boolean;
          classification: string;
        }>,
        error: null,
      };
  const openHits = openQueryResult.data;
  // If email_opens isn't available (e.g. migration 005 not applied yet),
  // fall back to the legacy opened_at flag on read_receipts so send-time
  // tracking doesn't appear fully broken.
  const legacyMode = !!openQueryResult.error;

  const hitsByToken = new Map<string, typeof openHits>();
  for (const h of openHits ?? []) {
    const arr = hitsByToken.get(h.token) ?? [];
    arr.push(h);
    hitsByToken.set(h.token, arr);
  }

  const receiptByEmailId = new Map(
    (receipts ?? []).map((r) => [r.email_message_id, r])
  );

  const sentEmailsWithReceipts: SentEmail[] = emails.map((email) => {
    const receipt = receiptByEmailId.get(email.id);
    if (!receipt) return { ...email, opened_at: null, open_count: 0, preloaded_only: false };

    if (legacyMode) {
      // No email_opens table — treat any opened_at on the receipt as a
      // single real open so the Sent view keeps working.
      const openedAt = receipt.opened_at ?? null;
      return {
        ...email,
        opened_at: openedAt,
        open_count: openedAt ? 1 : 0,
        preloaded_only: false,
      };
    }

    const hits = hitsByToken.get(receipt.token) ?? [];
    const { count, firstOpenedAt } = countDistinctReads(hits);
    const hasPreloadOnly =
      count === 0 &&
      hits.some(
        (h) =>
          !h.is_real_open &&
          (h.classification === "apple_mpp" || h.classification === "gmail_proxy_cached")
      );
    return {
      ...email,
      opened_at: firstOpenedAt ?? receipt.opened_at ?? null,
      open_count: count,
      preloaded_only: hasPreloadOnly,
    };
  });

  return (
    <main className="flex h-screen flex-col">
      <SentList emails={sentEmailsWithReceipts} />
    </main>
  );
}
