"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions?: Array<{ tool: string; result: string }>;
}

function ActionCard({ tool, result }: { tool: string; result: string }) {
  const parsed = (() => {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  })();

  if (!parsed) return null;

  if (tool === "send_batch_emails") {
    return (
      <div className="my-2 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-700">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M14 2L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M14 2L9.5 13.5 7 9 2.5 6.5 14 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          {parsed.summary}
        </div>
        {parsed.results && (
          <div className="mt-1.5 space-y-0.5">
            {(parsed.results as Array<{ to: string; status: string; sendAt?: string }>).map(
              (r, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-emerald-600">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      r.status === "sent"
                        ? "bg-emerald-400"
                        : r.status === "scheduled"
                        ? "bg-amber-400"
                        : "bg-red-400"
                    }`}
                  />
                  <span className="truncate">{r.to}</span>
                  <span className="ml-auto shrink-0 text-emerald-400">
                    {r.status === "scheduled" ? `scheduled ${r.sendAt?.slice(0, 16)}` : r.status}
                  </span>
                </div>
              )
            )}
          </div>
        )}
      </div>
    );
  }

  if (tool === "search_emails") {
    const results = parsed.results as Array<{
      from: string;
      subject: string;
      date: string;
      snippet?: string;
      body_preview?: string;
    }> | undefined;
    if (!results || results.length === 0) return null;

    return (
      <div className="my-2 rounded-lg border border-zinc-100 bg-zinc-50/50 px-3 py-2">
        <div className="text-[12px] font-medium text-zinc-500">
          Found {results.length} email{results.length !== 1 ? "s" : ""}
        </div>
        <div className="mt-1.5 space-y-1.5">
          {results.slice(0, 5).map((r, i) => (
            <div key={i} className="border-t border-zinc-100 pt-1.5 first:border-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12px] font-medium text-zinc-700">
                  {r.from?.split("<")[0]?.trim() || r.from}
                </span>
                <span className="shrink-0 text-[10px] text-zinc-400">
                  {r.date ? new Date(r.date).toLocaleDateString() : ""}
                </span>
              </div>
              <div className="truncate text-[11px] text-zinc-600">{r.subject}</div>
            </div>
          ))}
          {results.length > 5 && (
            <div className="text-[11px] text-zinc-400">+{results.length - 5} more</div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export default function ChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSend() {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", actions: [] },
    ]);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Chat request failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let actions: Array<{ tool: string; result: string }> = [];
      let textContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse out action markers
        while (true) {
          const actionStart = buffer.indexOf("__ACTION__");
          const actionEnd = buffer.indexOf("__END_ACTION__");

          if (actionStart !== -1 && actionEnd !== -1) {
            // Text before action
            textContent += buffer.slice(0, actionStart);
            // Parse action
            const actionJson = buffer.slice(actionStart + 10, actionEnd);
            try {
              const action = JSON.parse(actionJson);
              actions = [...actions, action];
            } catch {
              // Skip malformed action
            }
            buffer = buffer.slice(actionEnd + 14);
          } else {
            break;
          }
        }

        // If no pending action markers, flush buffer as text
        if (!buffer.includes("__ACTION__")) {
          textContent += buffer;
          buffer = "";
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: textContent.trim(), actions: [...actions] }
              : m
          )
        );
      }

      // Flush any remaining buffer
      if (buffer) {
        textContent += buffer;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: textContent.trim(), actions: [...actions] }
              : m
          )
        );
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content:
                  err instanceof Error
                    ? `Error: ${err.message}`
                    : "Something went wrong. Please try again.",
              }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center border-b border-zinc-100 px-6 py-3">
        <h1 className="text-[13px] font-semibold text-zinc-800">Chat</h1>
        <span className="ml-2 text-[11px] text-zinc-400">
          Send emails, search your inbox, ask questions
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1C4.13 1 1 3.8 1 7.25c0 1.94 1.03 3.66 2.63 4.78-.06.72-.35 1.73-.96 2.72 0 0 1.87-.25 3.43-1.17.6.15 1.23.22 1.9.22 3.87 0 7-2.8 7-6.25S11.87 1 8 1Z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                  className="text-zinc-300"
                />
              </svg>
            </div>
            <p className="text-[13px] font-medium text-zinc-500">MegaHuman Chat</p>
            <p className="mt-1 max-w-xs text-[12px] text-zinc-400">
              Send batch emails, schedule messages, search your inbox, or ask about your emails.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {[
                "Send an email to 5 people about Friday's meeting",
                "What was my last email from Sarah?",
                "Schedule a follow-up to John for tomorrow at 9am",
                "Show me all urgent unread emails",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full border border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500 transition-colors hover:border-zinc-200 hover:text-zinc-700"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.map((msg) => (
              <div key={msg.id}>
                <div
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                      msg.role === "user"
                        ? "bg-zinc-800 text-white"
                        : "bg-zinc-50 text-zinc-700 border border-zinc-100"
                    }`}
                  >
                    {msg.role === "assistant" && !msg.content && isLoading ? (
                      <span className="inline-flex items-center gap-1 text-zinc-400">
                        <span className="animate-pulse">Thinking</span>
                        <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                      </span>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                  </div>
                </div>
                {/* Action cards below assistant messages */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-1 ml-0 max-w-[85%]">
                    {msg.actions.map((action, i) => (
                      <ActionCard key={i} tool={action.tool} result={action.result} />
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-zinc-100 px-6 py-3">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send emails, search your inbox, ask anything..."
            rows={1}
            className="flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-[13px] text-zinc-800 placeholder:text-zinc-400 outline-none transition-colors focus:border-zinc-300"
            style={{ minHeight: "42px", maxHeight: "120px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "42px";
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M14 2L7 9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M14 2L9.5 13.5 7 9 2.5 6.5 14 2Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <p className="mx-auto mt-1.5 max-w-2xl text-[10px] text-zinc-300">
          Enter to send &middot; Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
