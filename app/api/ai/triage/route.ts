import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { structuredOutput } from "@/lib/claude";
import { createServiceRoleClient, type TriageLabel } from "@/lib/supabase";

const triageSchema = z.object({
  emails: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      subject: z.string(),
      snippet: z.string(),
    })
  ),
});

export type TriageResult = { id: string; label: TriageLabel }[];

const TRIAGE_SYSTEM = `You are an email triage assistant. Classify each email into exactly one category:
- urgent: needs immediate attention, time-sensitive, from someone important
- needs_reply: requires a response but not urgent
- fyi: informational, no action needed
- newsletter: marketing, newsletters, automated emails, subscriptions`;

/**
 * POST /api/ai/triage
 * Batch-classify emails into: urgent | needs_reply | fyi | newsletter
 * Called by Inngest job after sync — not typically called directly from UI.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = triageSchema.safeParse(await req.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const { emails } = body.data;

  const prompt = `Classify each of these emails. Return a JSON array with one entry per email.

${emails
  .map(
    (e, i) => `[${i + 1}] id="${e.id}"
From: ${e.from}
Subject: ${e.subject}
Preview: ${e.snippet}`
  )
  .join("\n\n")}`;

  const raw = await structuredOutput<{ classifications: TriageResult }>({
    system: TRIAGE_SYSTEM,
    prompt,
    toolName: "classify_emails",
    toolDescription: "Classify a list of emails by triage label",
    inputSchema: {
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string", enum: ["urgent", "needs_reply", "fyi", "newsletter"] },
            },
            required: ["id", "label"],
          },
        },
      },
      required: ["classifications"],
    },
    maxTokens: 1024,
  });

  const results = raw.classifications;

  // Upsert triage labels back into Supabase
  const supabase = createServiceRoleClient();
  await Promise.all(
    results.map(({ id, label }) =>
      supabase
        .from("emails")
        .update({ triage_label: label })
        .eq("id", id)
    )
  );

  return NextResponse.json({ results });
}
