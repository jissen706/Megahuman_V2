import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

type ExtendedSession = {
  user: { email: string };
  userId?: string;
};

/**
 * GET /api/emails/list?offset=10&limit=10
 * Returns paginated inbox emails for the current user.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const extSession = session as unknown as ExtendedSession;
  const userId = extSession.userId ?? emailToUserId(extSession.user.email);

  const offset = parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10);
  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "10", 10);
  const now = new Date().toISOString();

  const supabase = createServiceRoleClient();
  const { data: emails, error } = await supabase
    .from("emails")
    .select("*")
    .eq("user_id", userId)
    .eq("is_sent", false)
    .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
    .order("received_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ emails: emails ?? [] });
}
