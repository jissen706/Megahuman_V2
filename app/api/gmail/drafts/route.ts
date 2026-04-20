import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { listDrafts } from "@/lib/gmail";

type ExtendedSession = {
  user: { email: string };
  accessToken: string;
};

/**
 * GET /api/gmail/drafts
 * Returns the current user's Gmail drafts (most recent first).
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { accessToken } = session as unknown as ExtendedSession;
  try {
    const drafts = await listDrafts(accessToken, 50);
    return NextResponse.json({ drafts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list drafts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
