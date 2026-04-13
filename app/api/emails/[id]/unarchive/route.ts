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
 * POST /api/emails/[id]/unarchive
 * Adds INBOX label back in Gmail and marks is_archived=false in DB.
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

  // Add INBOX label back in Gmail
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: ["INBOX"] }),
  });

  // Mark as not archived in DB
  const db = createServiceRoleClient();
  await db.from("emails").update({ is_archived: false }).eq("id", id).eq("user_id", userId);

  return NextResponse.json({ unarchived: true });
}
