import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { anthropic, FAST_MODEL } from "@/lib/claude";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { sendEmail } from "@/lib/gmail";
import type Anthropic from "@anthropic-ai/sdk";

type ExtendedSession = {
  user: { email: string; name?: string };
  accessToken: string;
  userId: string;
};

const chatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })
  ),
});

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_emails",
    description:
      "Search the user's emails by sender, recipient, subject keyword, date range, or triage label. Use this to answer questions like 'when do I meet X', 'last email from Y', 'emails about Z'.",
    input_schema: {
      type: "object" as const,
      properties: {
        from_email: {
          type: "string",
          description: "Filter by sender email or name (partial match)",
        },
        to_email: {
          type: "string",
          description: "Filter by recipient email (partial match)",
        },
        subject_keyword: {
          type: "string",
          description: "Keyword to search in subject line",
        },
        body_keyword: {
          type: "string",
          description: "Keyword to search in email body",
        },
        after_date: {
          type: "string",
          description: "Only emails after this ISO date (e.g. 2026-01-01)",
        },
        before_date: {
          type: "string",
          description: "Only emails before this ISO date",
        },
        triage_label: {
          type: "string",
          enum: ["urgent", "needs_reply", "fyi", "newsletter"],
          description: "Filter by triage classification",
        },
        is_sent: {
          type: "boolean",
          description: "Filter sent emails only (true) or received only (false)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_email_thread",
    description:
      "Fetch all messages in an email thread by thread_id. Use this to read full email conversations for context.",
    input_schema: {
      type: "object" as const,
      properties: {
        thread_id: {
          type: "string",
          description: "The Gmail thread ID to fetch",
        },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "get_scheduled_emails",
    description:
      "Fetch all scheduled (pending) emails that haven't been sent yet. Shows recipient, subject, body, and scheduled send time.",
    input_schema: {
      type: "object" as const,
      properties: {
        include_sent: {
          type: "boolean",
          description: "Include already-sent scheduled emails (default false, only pending)",
        },
      },
      required: [],
    },
  },
  {
    name: "send_batch_emails",
    description:
      "Send one or more emails. Each email can be sent immediately or scheduled for later. All emails get read receipt tracking automatically. Use for mass-sending similar emails to multiple recipients.",
    input_schema: {
      type: "object" as const,
      properties: {
        emails: {
          type: "array",
          description: "Array of emails to send",
          items: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              subject: { type: "string", description: "Email subject line" },
              body: { type: "string", description: "Email body (plain text, newlines preserved)" },
              send_at: {
                type: "string",
                description:
                  "ISO datetime to schedule send (e.g. 2026-04-14T09:00:00Z). Omit to send immediately.",
              },
            },
            required: ["to", "subject", "body"],
          },
        },
      },
      required: ["emails"],
    },
  },
];

async function executeSearchEmails(
  userId: string,
  input: Record<string, unknown>
): Promise<string> {
  const supabase = createServiceRoleClient();
  let query = supabase
    .from("emails")
    .select("id, thread_id, from_email, to_email, subject, snippet, body_plain, received_at, is_sent, triage_label")
    .eq("user_id", userId)
    .order("received_at", { ascending: false })
    .limit((input.limit as number) || 10);

  if (input.from_email) {
    query = query.ilike("from_email", `%${input.from_email}%`);
  }
  if (input.to_email) {
    query = query.ilike("to_email", `%${input.to_email}%`);
  }
  if (input.subject_keyword) {
    query = query.ilike("subject", `%${input.subject_keyword}%`);
  }
  if (input.body_keyword) {
    query = query.ilike("body_plain", `%${input.body_keyword}%`);
  }
  if (input.after_date) {
    query = query.gte("received_at", input.after_date as string);
  }
  if (input.before_date) {
    query = query.lte("received_at", input.before_date as string);
  }
  if (input.triage_label) {
    query = query.eq("triage_label", input.triage_label as string);
  }
  if (input.is_sent !== undefined) {
    query = query.eq("is_sent", input.is_sent as boolean);
  }

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ results: [], message: "No emails found matching your criteria." });

  return JSON.stringify({
    results: data.map((e) => ({
      id: e.id,
      thread_id: e.thread_id,
      from: e.from_email,
      to: e.to_email,
      subject: e.subject,
      snippet: e.snippet,
      body_preview: e.body_plain?.slice(0, 500) || "",
      date: e.received_at,
      is_sent: e.is_sent,
      triage_label: e.triage_label,
    })),
    total: data.length,
  });
}

async function executeGetEmailThread(
  userId: string,
  input: Record<string, unknown>
): Promise<string> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("emails")
    .select("id, from_email, to_email, subject, body_plain, received_at, is_sent")
    .eq("user_id", userId)
    .eq("thread_id", input.thread_id as string)
    .order("received_at", { ascending: true });

  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ messages: [], message: "Thread not found." });

  return JSON.stringify({
    messages: data.map((m) => ({
      id: m.id,
      from: m.from_email,
      to: m.to_email,
      subject: m.subject,
      body: m.body_plain,
      date: m.received_at,
      is_sent: m.is_sent,
    })),
  });
}

async function executeGetScheduledEmails(
  userId: string,
  input: Record<string, unknown>
): Promise<string> {
  const supabase = createServiceRoleClient();
  let query = supabase
    .from("scheduled_sends")
    .select("id, to_email, subject, body, send_at, sent")
    .eq("user_id", userId)
    .order("send_at", { ascending: true });

  if (!input.include_sent) {
    query = query.eq("sent", false);
  }

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) {
    return JSON.stringify({ results: [], message: "No scheduled emails found." });
  }

  return JSON.stringify({
    results: data.map((s) => ({
      id: s.id,
      to: s.to_email,
      subject: s.subject,
      body: s.body,
      send_at: s.send_at,
      sent: s.sent,
    })),
    total: data.length,
  });
}

async function executeSendBatchEmails(
  userId: string,
  accessToken: string,
  input: Record<string, unknown>
): Promise<string> {
  if (!Array.isArray(input.emails) || input.emails.length === 0) {
    return JSON.stringify({ error: "No emails provided", summary: "0 sent, 0 scheduled, 0 failed", results: [] });
  }

  const emails = input.emails as Array<{
    to: string;
    subject: string;
    body: string;
    send_at?: string;
  }>;

  const supabase = createServiceRoleClient();
  const results: Array<{ to: string; status: string; messageId?: string; sendAt?: string; error?: string }> = [];

  for (const email of emails) {
    try {
      if (email.send_at) {
        // Scheduled send
        const { error } = await supabase.from("scheduled_sends").insert({
          user_id: userId,
          to_email: email.to,
          subject: email.subject,
          body: email.body,
          send_at: email.send_at,
          sent: false,
        });

        if (error) {
          results.push({ to: email.to, status: "error", error: error.message });
        } else {
          results.push({ to: email.to, status: "scheduled", sendAt: email.send_at });
        }
      } else {
        // Immediate send with tracking
        const trackingToken = crypto.randomUUID();

        await supabase.from("read_receipts").insert({
          token: trackingToken,
          user_id: userId,
          email_message_id: "",
          recipient_email: email.to,
          opened_at: null,
        });

        const sentMessageId = await sendEmail(accessToken, {
          to: email.to,
          subject: email.subject,
          body: email.body,
          trackingToken,
        });

        await supabase
          .from("read_receipts")
          .update({ email_message_id: sentMessageId })
          .eq("token", trackingToken);

        results.push({ to: email.to, status: "sent", messageId: sentMessageId });
      }
    } catch (err) {
      results.push({
        to: email.to,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const scheduled = results.filter((r) => r.status === "scheduled").length;
  const errors = results.filter((r) => r.status === "error").length;

  return JSON.stringify({
    summary: `${sent} sent, ${scheduled} scheduled, ${errors} failed`,
    results,
  });
}

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  accessToken: string
): Promise<string> {
  switch (toolName) {
    case "search_emails":
      return executeSearchEmails(userId, input);
    case "get_email_thread":
      return executeGetEmailThread(userId, input);
    case "get_scheduled_emails":
      return executeGetScheduledEmails(userId, input);
    case "send_batch_emails":
      return executeSendBatchEmails(userId, accessToken, input);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

export async function POST(req: NextRequest) {
  try {
  const rawSession = await auth();
  if (!rawSession) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const session = rawSession as unknown as ExtendedSession;
  const { accessToken } = session;
  const userId =
    (session.userId as string | undefined) ?? emailToUserId(session.user.email);
  const userName = session.user.name || session.user.email;

  let body;
  try {
    body = await req.json();
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse("Invalid request", { status: 400 });
  }

  const { messages } = parsed.data;

  const systemPrompt = `You are MegaHuman AI, an email assistant for ${userName}. Today's date is ${new Date().toISOString().slice(0, 10)}.

You help with:
1. **Sending emails** — single or batch (5-10+ at once). Always confirm details before sending. For batch sends with similar format, personalize each email appropriately.
2. **Querying emails** — search by sender, subject, date, content. Answer questions about meetings, deadlines, conversations.
3. **Email insights** — summarize threads, find patterns, track responses.

Guidelines:
- When asked to send multiple emails, use send_batch_emails with all emails in one call.
- For scheduled sends, convert relative times (e.g. "tomorrow at 9am") to ISO datetime.
- When searching, try multiple strategies if the first search returns no results (e.g. search by name, then by email domain).
- Keep responses concise and actionable.
- When showing email search results, format them clearly with sender, subject, date, and a brief preview.
- IMPORTANT: Before sending any emails, clearly list what you're about to send (recipients, subjects, bodies) and ask for confirmation, UNLESS the user has already provided all details explicitly and said to send.`;

  // Build the Anthropic messages array
  const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Tool-use loop: keep calling Claude until we get a final text response
  let currentMessages = [...anthropicMessages];
  const toolResults: Array<{ tool: string; result: string }> = [];

  for (let iteration = 0; iteration < 10; iteration++) {
    const response = await anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: currentMessages,
      tools: TOOLS,
    });

    // Collect text and tool_use blocks
    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      // No more tool calls — stream the final text response
      const finalText = textBlocks.map((b) => b.type === "text" ? b.text : "").join("");

      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // Send any tool results as JSON action events first
          for (const tr of toolResults) {
            controller.enqueue(
              encoder.encode(`\n__ACTION__${JSON.stringify(tr)}__END_ACTION__\n`)
            );
          }
          controller.enqueue(encoder.encode(finalText));
          controller.close();
        },
      });

      return new NextResponse(body, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Execute all tool calls
    const toolResultMessages: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;
      const result = await executeTool(
        block.name,
        block.input as Record<string, unknown>,
        userId,
        accessToken
      );
      toolResults.push({ tool: block.name, result });
      toolResultMessages.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    // Append assistant response and tool results to messages.
    // Reconstruct content blocks to match MessageParam input types.
    const assistantContent: Anthropic.ContentBlockParam[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      return { type: "text" as const, text: "" };
    });

    currentMessages = [
      ...currentMessages,
      { role: "assistant" as const, content: assistantContent },
      { role: "user" as const, content: toolResultMessages },
    ];
  }

  // If we hit max iterations, return what we have
  return new NextResponse("Max tool iterations reached", { status: 500 });
  } catch (err) {
    console.error("Chat route error:", err);
    return new NextResponse(
      err instanceof Error ? err.message : "Chat failed",
      { status: 500 }
    );
  }
}
