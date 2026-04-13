import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { archiveMessage } from "@/lib/gmail";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
  userId: string;
};

/**
 * POST /api/emails/[id]/archive
 * Removes INBOX label in Gmail and deletes from local DB.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const rawSession = await auth();
  if (!rawSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const session = rawSession as unknown as ExtendedSession;
  const userId = (session.userId as string | undefined) ?? emailToUserId(session.user.email);

  // Remove INBOX label in Gmail
  await archiveMessage(session.accessToken, id);

  // Mark as archived in DB (keeps email available in Archive tab)
  const db = createServiceRoleClient();
  await db.from("emails").update({ is_archived: true }).eq("id", id).eq("user_id", userId);

  return NextResponse.json({ archived: true });
}
