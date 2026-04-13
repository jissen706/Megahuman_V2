import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { streamText } from "@/lib/claude";
import { buildDraftSystemPrompt, DEFAULT_VOICE_PROFILE, type VoiceProfileData } from "@/lib/voice-profile";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

const draftSchema = z.object({
  mode: z.enum(["reply", "compose"]).default("reply"),
  // reply mode: thread to reply to
  threadMessages: z.array(
    z.object({
      from: z.string(),
      body: z.string(),
    })
  ).optional().default([]),
  tone: z.enum(["brief", "detailed"]).default("brief"),
  currentDraft: z.string().optional(), // existing text to build upon
  // compose mode: context for new email
  composeContext: z.object({
    to: z.string(),
    subject: z.string(),
    notes: z.string(),
    recipientName: z.string().optional(),
    threadMessages: z.array(z.object({ from: z.string(), body: z.string() })).optional(),
  }).optional(),
});

type ExtendedSession = {
  user: { email: string; name?: string };
  userId?: string;
};

/**
 * POST /api/ai/draft
 * Streams a voice-matched draft.
 * mode="reply": drafts a reply to the provided thread messages.
 * mode="compose": writes a new email from scratch using to/subject/notes as context.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const parsed = draftSchema.safeParse(await req.json());
  if (!parsed.success) {
    return new Response(JSON.stringify(parsed.error.flatten()), { status: 400 });
  }

  const { mode, threadMessages, tone, composeContext, currentDraft } = parsed.data;

  const extSession = session as unknown as ExtendedSession;
  const userId = extSession.userId ?? emailToUserId(extSession.user.email);
  const fullName = extSession.user.name ?? extSession.user.email;
  const userName = fullName.split(" ")[0]; // first name only

  const supabase = createServiceRoleClient();

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
      // malformed stored profile — use defaults
    }
  }

  let system: string;
  let prompt: string;

  if (mode === "compose") {
    const { to = "", subject = "", notes = "", recipientName, threadMessages: ctxThread } = composeContext ?? {};
    const displayName = recipientName || (to.match(/^(.+?)\s*</) ? to.match(/^(.+?)\s*</)![1].replace(/"/g, "").trim() : to.split("@")[0]);

    system = buildDraftSystemPrompt(userName, voiceProfile, tone).replace(
      "drafting an email reply",
      "writing a new email"
    );

    const needsSubject = !subject.trim();
    const lines = [
      needsSubject
        ? `Write a complete email in ${userName}'s voice. Output the subject line as the FIRST line in exactly this format: "Subject: <subject>", then a blank line, then the email body. Do not include any other prefix or label.`
        : `Write a complete email in ${userName}'s voice.`,
      `To: ${displayName}${to ? ` <${to.replace(/^.*<(.+)>.*$/, "$1").trim() || to}>` : ""}`,
      subject ? `Subject: ${subject}` : "",
      ctxThread?.length
        ? `\nPrior thread context (most recent exchange — use this to inform the email):\n${ctxThread.map((m) => `From: ${m.from}\n${m.body}`).join("\n\n---\n\n")}`
        : "",
      notes
        ? `\nWhat they want to say:\n${notes}`
        : "\nWrite an appropriate email based on the context above.",
    ].filter(Boolean);
    prompt = lines.join("\n");
  } else {
    system = buildDraftSystemPrompt(userName, voiceProfile, tone);
    const threadContext = (threadMessages ?? [])
      .map((m) => `From: ${m.from}\n\n${m.body}`)
      .join("\n\n---\n\n");
    prompt = currentDraft?.trim()
      ? `Reply to this email thread:\n\n${threadContext}\n\n---\n\nThe user has already started writing this reply — improve and complete it, preserving their intent and wording where possible:\n\n${currentDraft}`
      : `Reply to this email thread:\n\n${threadContext}`;
  }

  const maxTokens = tone === "brief" ? 256 : 600;
  const stream = await streamText({ system, prompt, maxTokens });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
