import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { structuredOutput } from "@/lib/claude";
import { DEFAULT_VOICE_PROFILE, type VoiceProfileData } from "@/lib/voice-profile";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

const handleSchema = z.object({
  emailId: z.string(),
  threadMessages: z.array(
    z.object({
      from: z.string(),
      subject: z.string(),
      body: z.string(),
    })
  ),
});

export const handleResultSchema = z.object({
  action: z.enum(["draft_reply", "snooze", "mark_fyi"]),
  reasoning: z.string(),
  draft_content: z.string().optional(),
  snooze_days: z.number().optional(),
});

export type HandleResult = z.infer<typeof handleResultSchema>;

const HANDLE_SYSTEM = `You are an AI email assistant. Given an email thread, decide the best action and execute it in one step:
- draft_reply: email needs a response — you MUST include a complete ready-to-send draft in draft_content
- snooze: no action needed now but should be revisited — include snooze_days (1-7)
- mark_fyi: purely informational, no reply needed

Always populate draft_content when action is draft_reply. Be decisive and concise.`;

/**
 * POST /api/ai/handle
 * "Handle this" agent: reads email, decides best action, returns structured result.
 * Client is responsible for executing the action (update DB, show draft, etc.)
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = handleSchema.safeParse(await req.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const { threadMessages } = body.data;

  const extSession = session as unknown as { user: { email: string; name?: string }; userId?: string };
  const userId = extSession.userId ?? emailToUserId(extSession.user.email);
  const userName = extSession.user.name ?? extSession.user.email;

  const supabase = createServiceRoleClient();

  // Fetch voice profile for draft generation
  let voiceProfile: VoiceProfileData = DEFAULT_VOICE_PROFILE;
  const { data: profileRow } = await supabase
    .from("voice_profiles")
    .select("profile_text")
    .eq("user_id", userId)
    .single();
  if (profileRow?.profile_text) {
    try {
      voiceProfile = JSON.parse(profileRow.profile_text) as VoiceProfileData;
    } catch {
      // Malformed stored profile — use defaults
    }
  }

  const threadContext = threadMessages
    .map((m) => `From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`)
    .join("\n\n---\n\n");

  const prompt = `Decide what to do with this email thread and take action:\n\n${threadContext}`;

  type RawResult = {
    action: "draft_reply" | "snooze" | "mark_fyi";
    reasoning: string;
    draft_content?: string;
    snooze_days?: number;
  };

  const raw = await structuredOutput<RawResult>({
    system: HANDLE_SYSTEM,
    prompt,
    toolName: "handle_email",
    toolDescription: "Decide how to handle an email and draft a reply if needed",
    inputSchema: {
      properties: {
        action: { type: "string", enum: ["draft_reply", "snooze", "mark_fyi"] },
        reasoning: { type: "string" },
        draft_content: { type: "string" },
        snooze_days: { type: "number", minimum: 1, maximum: 7 },
      },
      required: ["action", "reasoning"],
    },
    maxTokens: 1024,
    fast: true,
  });

  const result: HandleResult = handleResultSchema.parse(raw);

  // Persist the action to DB immediately so the inbox reflects it
  const { emailId } = body.data;
  const db = createServiceRoleClient();
  if (result.action === "mark_fyi") {
    await db.from("emails").update({ triage_label: "fyi" }).eq("id", emailId);
  } else if (result.action === "snooze") {
    const snoozeUntil = new Date();
    snoozeUntil.setDate(snoozeUntil.getDate() + (result.snooze_days ?? 3));
    await db.from("emails").update({ snoozed_until: snoozeUntil.toISOString() }).eq("id", emailId);
  }

  return NextResponse.json(result);
}
