import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { streamText } from "@/lib/claude";

const summarizeSchema = z.object({
  threadMessages: z.array(
    z.object({
      from: z.string(),
      subject: z.string().optional(),
      body: z.string(),
    })
  ).min(1),
});

/**
 * POST /api/ai/summarize
 * Streams a concise thread summary.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const parsed = summarizeSchema.safeParse(await req.json());
  if (!parsed.success) {
    return new Response(JSON.stringify(parsed.error.flatten()), { status: 400 });
  }

  const { threadMessages } = parsed.data;

  const threadContext = threadMessages
    .map((m) => `From: ${m.from}\n\n${m.body}`)
    .join("\n\n---\n\n");

  const system =
    "You are a concise email summarizer. Summarize the key points of this email thread in 2–4 short bullet points. Focus on decisions made, action items, and the current status. Be direct and specific — no filler phrases.";

  const prompt = `Summarize this email thread:\n\n${threadContext}`;

  const stream = await streamText({ system, prompt, maxTokens: 300 });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
