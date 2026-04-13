import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { DEFAULT_VOICE_PROFILE, extractVoiceProfile, bestPlainText, type VoiceProfileData } from "@/lib/voice-profile";
import { fetchSentMessages } from "@/lib/gmail";

type ExtendedSession = {
  user: { email: string };
  accessToken?: string;
  userId?: string;
};

/** POST /api/voice-profile — force rebuild the voice profile directly from Gmail sent history */
export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ext = session as unknown as ExtendedSession;
  const userId = ext.userId ?? emailToUserId(ext.user.email);
  const accessToken = ext.accessToken;
  if (!accessToken) return NextResponse.json({ error: "No access token" }, { status: 401 });

  // Fetch 200 sent messages directly from Gmail (not limited to what's been synced)
  const sentMessages = await fetchSentMessages(accessToken, 200);

  const bodies = sentMessages
    .map((m) => bestPlainText({ body_plain: m.bodyPlain, body_html: m.bodyHtml }))
    .filter((b) => b.length > 0);

  const { data, raw } = await extractVoiceProfile(bodies);

  const db = createServiceRoleClient();
  await db.from("voice_profiles").upsert({
    user_id: userId,
    profile_text: raw,
    updated_at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ext = session as unknown as ExtendedSession;
  const userId = ext.userId ?? emailToUserId(ext.user.email);

  const db = createServiceRoleClient();
  const { data } = await db
    .from("voice_profiles")
    .select("profile_text")
    .eq("user_id", userId)
    .single();

  if (!data?.profile_text) {
    return NextResponse.json({ profile: null, hasProfile: false });
  }

  try {
    const profile = JSON.parse(data.profile_text) as VoiceProfileData;
    return NextResponse.json({ profile, hasProfile: true });
  } catch {
    return NextResponse.json({ profile: DEFAULT_VOICE_PROFILE, hasProfile: false });
  }
}
