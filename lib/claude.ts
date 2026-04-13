import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODEL = "claude-sonnet-4-6";
export const FAST_MODEL = "claude-haiku-4-5-20251001";

/**
 * Stream a text response from Claude.
 * Returns a ReadableStream compatible with Next.js streaming responses.
 */
export async function streamText(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of stream) {
        if (
          chunk.type === "content_block_delta" &&
          chunk.delta.type === "text_delta"
        ) {
          controller.enqueue(encoder.encode(chunk.delta.text));
        }
      }
      controller.close();
    },
    cancel() {
      stream.abort();
    },
  });
}

/**
 * Get a structured JSON response from Claude using tool_use.
 * Forces Claude to call the named tool, returns the input as typed T.
 */
export async function structuredOutput<T>(opts: {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
  fast?: boolean; // use Haiku for simple classification tasks
}): Promise<T> {
  const response = await anthropic.messages.create({
    model: opts.fast ? FAST_MODEL : MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: {
          type: "object" as const,
          ...opts.inputSchema,
        },
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Claude did not call tool ${opts.toolName}`);
  }

  return toolUse.input as T;
}
