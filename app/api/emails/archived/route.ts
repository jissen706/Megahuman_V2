import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  userId: string;
};

export async function GET() {
  const rawSession = await auth();
  if (!rawSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const session = rawSession as unknown as ExtendedSession;
  const userId = (session.userId as string | undefined) ?? emailToUserId(session.user.email);

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("emails")
    .select("id,thread_id,user_id,from_email,subject,snippet,received_at,is_sent,is_read,is_archived,triage_label,snoozed_until,follow_up_at,attachments")
    .eq("user_id", userId)
    .eq("is_archived", true)
    .order("received_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
