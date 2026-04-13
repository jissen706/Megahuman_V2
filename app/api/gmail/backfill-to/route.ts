import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { fetchSentMessages } from "@/lib/gmail";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId: string;
};

/**
 * POST /api/gmail/backfill-to
 * One-time backfill of to_email for existing sent emails.
 */
export async function POST() {
  const rawSession = await auth();
  if (!rawSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const session = rawSession as unknown as ExtendedSession;
  const userId = (session.userId as string | undefined) ?? emailToUserId(session.user.email);

  const db = createServiceRoleClient();
  const sent = await fetchSentMessages(session.accessToken, 100);

  await Promise.all(
    sent.map((m) =>
      db.from("emails").update({ to_email: m.to || null }).eq("id", m.id)
    )
  );

  return NextResponse.json({ updated: sent.length });
}
