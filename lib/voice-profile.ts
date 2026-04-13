import { anthropic, FAST_MODEL } from "./claude";

/** Strip HTML tags and decode basic entities for plain-text extraction */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Strip Gmail/Outlook quoted reply blocks before removing tags
    .replace(/<div class="gmail_quote"[\s\S]*?<\/div>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Return best plain-text body from a row that has body_plain and/or body_html */
export function bestPlainText(row: { body_plain?: string | null; body_html?: string | null }): string {
  const plain = row.body_plain?.trim() ?? "";
  if (plain) return plain;
  const html = row.body_html?.trim() ?? "";
  return html ? stripHtml(html) : "";
}

export const VOICE_PROFILE_SYSTEM = `You are an expert writing analyst. Your job is to extract a concise style profile from a set of emails.`;

export const VOICE_PROFILE_PROMPT = (emails: string) => `
Analyze these sent emails and extract a writing style profile.

Emails to analyze (newest first):
---
${emails}
---

Respond with only valid JSON, no markdown fences. Return a single JSON object with exactly these keys:

{
  "greetings": string[],          // actual greeting phrases used, e.g. ["Hi [name],", "Hey,"] — empty array if none used
  "signoffs": string[],           // actual sign-off phrases used, e.g. ["Best,", "Thanks,"] — empty array if none used
  "avgLength": "short" | "medium" | "long",   // short = <50 words, medium = 50–150, long = 150+
  "formalityScore": 1 | 2 | 3 | 4 | 5,       // 1 = very casual, 5 = very formal
  "usesPunctuation": boolean,     // true if they consistently use end-of-sentence punctuation
  "usesEmoji": boolean,           // true if they use emoji in emails
  "characteristicPhrases": string[],  // up to 6 actual recurring phrases, words, or expressions they use
  "paragraphStyle": "single" | "multi" | "bullets",  // how they typically structure body text
  "sampleSignoff": string         // the single most common sign-off ready to paste, e.g. "Best," — empty string if none
}
`;

export interface VoiceProfileData {
  greetings: string[];
  signoffs: string[];
  avgLength: "short" | "medium" | "long";
  formalityScore: 1 | 2 | 3 | 4 | 5;
  usesPunctuation: boolean;
  usesEmoji: boolean;
  characteristicPhrases: string[];
  paragraphStyle: "single" | "multi" | "bullets";
  sampleSignoff: string;
  examples: string[]; // 3 real short sent emails — used as few-shot examples
}

export const DEFAULT_VOICE_PROFILE: VoiceProfileData = {
  greetings: ["Hi,"],
  signoffs: ["Best,", "Thanks,"],
  avgLength: "medium",
  formalityScore: 3,
  usesPunctuation: true,
  usesEmoji: false,
  characteristicPhrases: [],
  paragraphStyle: "single",
  sampleSignoff: "Best,",
  examples: [],
};

/**
 * Extract a voice profile from the k=25 most recent sent email bodies.
 * Caller must pass bodies sorted newest-first.
 * Returns { data: VoiceProfileData, raw: string } for DB storage + use.
 */
export async function extractVoiceProfile(
  sentEmailBodies: string[]
): Promise<{ data: VoiceProfileData; raw: string }> {
  if (sentEmailBodies.length === 0) {
    const raw = JSON.stringify(DEFAULT_VOICE_PROFILE);
    return { data: DEFAULT_VOICE_PROFILE, raw };
  }

  // Pick up to 10 examples for few-shot prompting.
  // Truncate each to 500 chars (opening shows style just as well as full email).
  // Only skip emails shorter than 30 chars (one-word replies like "test").
  const examples = sentEmailBodies
    .map((b) => b.trim())
    .filter((b) => b.length >= 30)
    .map((b) => b.slice(0, 500))
    .slice(0, 10);

  // Take k=50 most recent, truncate each to 1500 chars
  const recent = sentEmailBodies.slice(0, 50);
  const emailsText = recent
    .map((body, i) => `[Email ${i + 1} — most recent first]\n${body.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  const response = await anthropic.messages.create({
    model: FAST_MODEL,
    max_tokens: 2048,
    system: VOICE_PROFILE_SYSTEM,
    messages: [{ role: "user", content: VOICE_PROFILE_PROMPT(emailsText) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude for voice profile");
  }

  const raw = textBlock.text.trim();

  try {
    const parsed = JSON.parse(raw) as Partial<VoiceProfileData>;
    // Merge with defaults to guard against missing keys
    const data: VoiceProfileData = {
      greetings: Array.isArray(parsed.greetings) ? parsed.greetings : DEFAULT_VOICE_PROFILE.greetings,
      signoffs: Array.isArray(parsed.signoffs) ? parsed.signoffs : DEFAULT_VOICE_PROFILE.signoffs,
      avgLength: (["short", "medium", "long"] as const).includes(parsed.avgLength as "short" | "medium" | "long")
        ? (parsed.avgLength as "short" | "medium" | "long")
        : DEFAULT_VOICE_PROFILE.avgLength,
      formalityScore: ([1, 2, 3, 4, 5] as const).includes(parsed.formalityScore as 1 | 2 | 3 | 4 | 5)
        ? (parsed.formalityScore as 1 | 2 | 3 | 4 | 5)
        : DEFAULT_VOICE_PROFILE.formalityScore,
      usesPunctuation: typeof parsed.usesPunctuation === "boolean" ? parsed.usesPunctuation : DEFAULT_VOICE_PROFILE.usesPunctuation,
      usesEmoji: typeof parsed.usesEmoji === "boolean" ? parsed.usesEmoji : DEFAULT_VOICE_PROFILE.usesEmoji,
      characteristicPhrases: Array.isArray(parsed.characteristicPhrases)
        ? parsed.characteristicPhrases.slice(0, 6)
        : DEFAULT_VOICE_PROFILE.characteristicPhrases,
      paragraphStyle: (["single", "multi", "bullets"] as const).includes(parsed.paragraphStyle as "single" | "multi" | "bullets")
        ? (parsed.paragraphStyle as "single" | "multi" | "bullets")
        : DEFAULT_VOICE_PROFILE.paragraphStyle,
      sampleSignoff: typeof parsed.sampleSignoff === "string" ? parsed.sampleSignoff : DEFAULT_VOICE_PROFILE.sampleSignoff,
      examples,
    };
    return { data, raw: JSON.stringify(data) };
  } catch {
    // If Claude returned malformed JSON, fall back to defaults but preserve examples
    const fallback: VoiceProfileData = { ...DEFAULT_VOICE_PROFILE, examples };
    return { data: fallback, raw: JSON.stringify(fallback) };
  }
}

/**
 * Build the system prompt for draft generation using structured VoiceProfileData.
 */
export function buildDraftSystemPrompt(
  userName: string,
  voiceProfile: VoiceProfileData,
  tone: "brief" | "detailed" = "brief"
): string {
  const { greetings, signoffs, avgLength, formalityScore, usesPunctuation, usesEmoji, characteristicPhrases, paragraphStyle, sampleSignoff } = voiceProfile;

  const greetingInstruction = greetings.length > 0
    ? `Greetings: choose naturally from these options: ${greetings.map((g) => `"${g}"`).join(", ")}.`
    : "Do not use a greeting.";

  const signoffInstruction = signoffs.length > 0
    ? `Always end with one of these sign-offs: ${signoffs.map((s) => `"${s}"`).join(", ")}. Most common: "${sampleSignoff}". Sign your name as "${userName}" (first name only).`
    : `Do not use a sign-off, but if you must, use just the first name: "${userName}".`;

  const lengthInstruction = tone === "brief"
    ? `Length: be brief — target under 80 words. This user typically writes ${avgLength} emails; lean shorter.`
    : `Length: be thorough — target 150–300 words. This user typically writes ${avgLength} emails; match that range.`;

  const formalityInstruction = formalityScore <= 2
    ? "Tone: casual and conversational."
    : formalityScore >= 4
    ? "Tone: formal and professional."
    : "Tone: friendly but professional.";

  const punctuationInstruction = usesPunctuation
    ? "Use consistent end-of-sentence punctuation."
    : "Punctuation is minimal — don't over-punctuate.";

  const emojiInstruction = usesEmoji
    ? "Emoji usage is fine if it fits naturally."
    : "Do not use emoji.";

  const phraseInstruction = characteristicPhrases.length > 0
    ? `Weave in 1–2 of these characteristic phrases if they fit naturally: ${characteristicPhrases.map((p) => `"${p}"`).join(", ")}.`
    : "";

  const paragraphInstruction = paragraphStyle === "bullets"
    ? "Use bullet points for lists."
    : paragraphStyle === "multi"
    ? "Use multiple short paragraphs."
    : "Keep the body as a single paragraph unless a list is truly needed.";

  const examplesBlock = (voiceProfile.examples ?? []).length > 0
    ? `\nHere are real emails this person has written — match this style exactly:\n\n${(voiceProfile.examples ?? []).map((e, i) => `[Example ${i + 1}]\n${e}`).join("\n\n")}\n`
    : "";

  return [
    `You are drafting an email on behalf of ${userName}.`,
    `Match their writing style exactly:`,
    greetingInstruction,
    signoffInstruction,
    lengthInstruction,
    formalityInstruction,
    punctuationInstruction,
    emojiInstruction,
    phraseInstruction,
    paragraphInstruction,
    examplesBlock,
    `Never use em-dashes (—). Use commas or separate sentences instead.`,
    `Do not explain yourself. Output only the email body — no preamble, no "Here is a draft:".`,
  ]
    .filter(Boolean)
    .join("\n");
}
