import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { anthropic, FAST_MODEL } from "@/lib/claude";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { createDraft, plainTextToHtml, sendEmail, type DraftAttachmentInput } from "@/lib/gmail";
import { buildTrackingPixel, extractSenderContext } from "@/lib/read-receipt";
import { insertReceipt, updateReceipt } from "@/lib/read-receipt-db";
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
  {
    name: "create_batch_drafts",
    description:
      "Create multiple Gmail DRAFTS (not sent) personalized per recipient. Use whenever the user wants to draft multiple similar emails to different people — they will review and send from the Drafts tab themselves. Every draft automatically attaches the PDF the user uploaded in this chat turn (if any). When writing each draft, subtly tailor 2-3 words in the subject line per recipient, and adapt the body to their role/company/context while preserving the user's provided wording for the core message. Do NOT invent facts about a recipient; only personalize based on information the user provided.",
    input_schema: {
      type: "object" as const,
      properties: {
        drafts: {
          type: "array",
          description:
            "One draft per recipient. Each entry should be personalized, but the core message must reflect what the user specified.",
          items: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              name: {
                type: "string",
                description: "Recipient's first name if known (used for salutation)",
              },
              subject: { type: "string", description: "Subject line for this recipient" },
              body: {
                type: "string",
                description:
                  "Full email body in plain text, including greeting and sign-off. Newlines are preserved.",
              },
            },
            required: ["to", "subject", "body"],
          },
        },
      },
      required: ["drafts"],
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
  input: Record<string, unknown>,
  senderCtx: { senderIp: string; senderUa: string }
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
        const sentAt = new Date().toISOString();

        await insertReceipt(supabase, {
          token: trackingToken,
          user_id: userId,
          email_message_id: "",
          recipient_email: email.to,
          opened_at: null,
          sent_at: sentAt,
          sender_ip: senderCtx.senderIp || null,
          sender_user_agent: senderCtx.senderUa || null,
        });

        const sentMessageId = await sendEmail(accessToken, {
          to: email.to,
          subject: email.subject,
          body: email.body,
          trackingToken,
        });

        await updateReceipt(supabase, trackingToken, { email_message_id: sentMessageId });

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

async function executeCreateBatchDrafts(
  userId: string,
  accessToken: string,
  input: Record<string, unknown>,
  attachment: DraftAttachmentInput | null,
  senderCtx: { senderIp: string; senderUa: string }
): Promise<string> {
  if (!Array.isArray(input.drafts) || input.drafts.length === 0) {
    return JSON.stringify({
      error: "No drafts provided",
      summary: "0 created, 0 failed",
      results: [],
    });
  }

  const drafts = input.drafts as Array<{
    to: string;
    name?: string;
    subject: string;
    body: string;
  }>;

  const supabase = createServiceRoleClient();
  const attachments = attachment ? [attachment] : [];
  const results: Array<{
    to: string;
    name?: string;
    subject: string;
    status: string;
    draftId?: string;
    error?: string;
  }> = [];

  for (const d of drafts) {
    try {
      // Pre-insert tracking row so pixel requests resolve once draft is sent.
      // sent_at is null for now — the MegaHuman draft-send endpoint will
      // set it when the draft actually ships. If the user sends via Gmail
      // natively we can't know the exact send time; the classifier still
      // works without it (grace period check is skipped).
      const trackingToken = crypto.randomUUID();
      await insertReceipt(supabase, {
        token: trackingToken,
        user_id: userId,
        email_message_id: "",
        recipient_email: d.to,
        opened_at: null,
        sent_at: null,
        sender_ip: senderCtx.senderIp || null,
        sender_user_agent: senderCtx.senderUa || null,
      });

      const htmlBody = plainTextToHtml(d.body) + buildTrackingPixel(trackingToken);
      const { draftId, messageId } = await createDraft(accessToken, {
        to: d.to,
        subject: d.subject,
        bodyHtml: htmlBody,
        attachments,
      });

      // Link the tracking row to the draft's message id. When the user
      // sends the draft later, the pixel already embeds the token; the
      // row updates opened_at on pixel fetch.
      await updateReceipt(supabase, trackingToken, { email_message_id: messageId });

      results.push({
        to: d.to,
        name: d.name,
        subject: d.subject,
        status: "created",
        draftId,
      });
    } catch (err) {
      results.push({
        to: d.to,
        name: d.name,
        subject: d.subject,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  const errors = results.filter((r) => r.status === "error").length;

  return JSON.stringify({
    summary: `${created} draft${created === 1 ? "" : "s"} created${
      attachment ? ` with ${attachment.filename}` : ""
    }${errors ? `, ${errors} failed` : ""}`,
    results,
    attachmentFilename: attachment?.filename,
  });
}

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  accessToken: string,
  attachment: DraftAttachmentInput | null,
  senderCtx: { senderIp: string; senderUa: string }
): Promise<string> {
  switch (toolName) {
    case "search_emails":
      return executeSearchEmails(userId, input);
    case "get_email_thread":
      return executeGetEmailThread(userId, input);
    case "get_scheduled_emails":
      return executeGetScheduledEmails(userId, input);
    case "send_batch_emails":
      return executeSendBatchEmails(userId, accessToken, input, senderCtx);
    case "create_batch_drafts":
      return executeCreateBatchDrafts(userId, accessToken, input, attachment, senderCtx);
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

  const senderCtx = extractSenderContext(req.headers);

  // Accept either JSON or multipart/form-data (when an attachment is included).
  let body: unknown;
  let attachment: DraftAttachmentInput | null = null;
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const messagesRaw = form.get("messages");
      if (typeof messagesRaw !== "string") {
        return new NextResponse("Missing messages field", { status: 400 });
      }
      try {
        body = JSON.parse(messagesRaw);
      } catch {
        return new NextResponse("messages field is not valid JSON", { status: 400 });
      }
      const file = form.get("attachment");
      if (file && file instanceof File && file.size > 0) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        attachment = {
          filename: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
          data: Buffer.from(bytes),
        };
      }
    } else {
      body = await req.json();
    }
  } catch {
    return new NextResponse("Invalid request body", { status: 400 });
  }

  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse("Invalid request", { status: 400 });
  }

  const { messages } = parsed.data;

  const attachmentLine = attachment
    ? `\nATTACHMENT: The user uploaded "${attachment.filename}" (${attachment.mimeType}) with this turn. If they ask you to draft or send emails, attach this file automatically. create_batch_drafts attaches it to every draft it creates.`
    : "";

  const systemPrompt = `You are MegaHuman AI, an email assistant for ${userName}. Today's date is ${new Date().toISOString().slice(0, 10)}.

You help with:
1. **Sending emails** — single or batch (5-10+ at once). Always confirm details before sending. For batch sends with similar format, personalize each email appropriately.
2. **Drafting emails** — use create_batch_drafts to create Gmail DRAFTS (not sent) for the user to review later in the Drafts tab. This is the right tool when the user says "draft", "write drafts", "create drafts", or wants to check before sending.
3. **Querying emails** — search by sender, subject, date, content. Answer questions about meetings, deadlines, conversations.
4. **Email insights** — summarize threads, find patterns, track responses.

Guidelines:
- When asked to send multiple emails, use send_batch_emails. When asked to DRAFT multiple emails, use create_batch_drafts.
- For create_batch_drafts: use the exact wording the user provided for the core message. Personalize only the variable parts: recipient name in the greeting, company/role references, subject line (2-3 word adjustments per recipient). If the user did not specify a greeting or sign-off, use a simple "Hi {Name}," and no sign-off, or match their provided style. Do NOT invent facts about the recipient.
- Parse recipients from free-form text. Handle both paragraph form ("send to alice@acme.com (PM), bob@beta.io (Eng Lead)") and listed form (newline-separated). Extract email, name, and role/company when present.
- For scheduled sends, convert relative times (e.g. "tomorrow at 9am") to ISO datetime.
- When searching, try multiple strategies if the first search returns no results (e.g. search by name, then by email domain).
- Keep responses concise and actionable.
- When showing email search results, format them clearly with sender, subject, date, and a brief preview.
- IMPORTANT: Before SENDING emails, list recipients/subjects/bodies and ask for confirmation, UNLESS the user has already provided all details explicitly and said to send. Before creating DRAFTS you do NOT need to confirm — just create them and tell the user to review in the Drafts tab.${attachmentLine}`;

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
        accessToken,
        attachment,
        senderCtx
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
