"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { type Email } from "@/lib/supabase";
import EmailMessage from "./EmailMessage";
import DraftEditor from "./DraftEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

const SNOOZE_OPTIONS = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
];

interface Props {
  threadId: string;
  messages: Email[];
}

export default function ThreadView({ threadId, messages }: Props) {
  const router = useRouter();
  const [showDraft, setShowDraft] = useState(false);
  const [initialDraft, setInitialDraft] = useState("");
  const [summary, setSummary] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "r") { e.preventDefault(); setInitialDraft(""); setShowDraft(true); }
      if (e.key === "e") { e.preventDefault(); archive(); }
      if (e.key === "s") { e.preventDefault(); summarize(); }
      if (e.key === "Escape" || e.key === "ArrowLeft") router.back();
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const last = messages[messages.length - 1];
        const from = last?.from_email ?? "";
        const nameMatch = from.match(/^(.+?)\s*</);
        const recipientName = nameMatch ? nameMatch[1].replace(/"/g, "").trim() : "";
        const recipientEmail = from.replace(/^.*<(.+)>.*$/, "$1").trim() || from;
        window.dispatchEvent(new CustomEvent("megahuman:compose", {
          detail: {
            to: recipientEmail,
            recipientName,
            threadMessages: messages.map((m) => ({ from: m.from_email, body: m.body_plain || m.snippet })),
          },
        }));
      }
    }
    function onArchiveEvent() { archive(); }
    function onReplyEvent() { setInitialDraft(""); setShowDraft(true); }
    function onSummarizeEvent() { summarize(); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("megahuman:archive", onArchiveEvent);
    window.addEventListener("megahuman:reply", onReplyEvent);
    window.addEventListener("megahuman:summarize", onSummarizeEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("megahuman:archive", onArchiveEvent);
      window.removeEventListener("megahuman:reply", onReplyEvent);
      window.removeEventListener("megahuman:summarize", onSummarizeEvent);
    };
  }, [router]);

  async function archive() {
    const id = messages.find((m) => !m.is_sent)?.id;
    if (!id) return;
    await fetch(`/api/emails/${id}/archive`, { method: "POST" });
    router.back();
  }

  async function snooze(days: number) {
    const snoozeUntil = new Date();
    snoozeUntil.setDate(snoozeUntil.getDate() + days);
    await fetch(`/api/emails/${messages[0]?.id}/snooze`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snoozedUntil: snoozeUntil.toISOString() }),
    });
    toast.success(`Snoozed for ${days} day${days === 1 ? "" : "s"}`);
    router.refresh();
  }

  async function summarize() {
    if (isSummarizing) return;
    if (summary) { setSummary(""); return; }
    setIsSummarizing(true);
    setSummary("");
    try {
      const res = await fetch("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadMessages: messages.map((m) => ({
            from: m.from_email,
            subject: m.subject,
            body: m.body_plain || m.snippet,
          })),
        }),
      });
      if (!res.ok || !res.body) throw new Error("Summarize failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setSummary((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch {
      toast.error("Couldn't summarize thread");
    } finally {
      setIsSummarizing(false);
    }
  }


  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="flex flex-1 flex-col overflow-hidden"
    >
      {/* Thread header */}
      <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={() => router.back()}
            className="shrink-0 text-zinc-400 transition-colors hover:text-zinc-700"
            aria-label="Back"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L6 8l4 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <h2 className="truncate text-[14px] font-semibold text-zinc-900 leading-none">
            {messages[0]?.subject ?? "Thread"}
          </h2>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {/* Summarize */}
          <button
            onClick={summarize}
            disabled={isSummarizing}
            className="text-[12px] text-zinc-400 transition-colors hover:text-zinc-700 disabled:opacity-40"
          >
            <motion.span
              animate={isSummarizing ? { opacity: [1, 0.3, 1] } : {}}
              transition={isSummarizing ? { duration: 0.8, repeat: Infinity } : {}}
            >
              {isSummarizing ? "Summarizing…" : summary ? "Hide summary" : "Summarize"}
            </motion.span>
          </button>

          {/* Overflow: Archive + Snooze */}
          <DropdownMenu>
            <DropdownMenuTrigger className="text-[12px] text-zinc-400 transition-colors hover:text-zinc-700">
              •••
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={archive} className="text-[13px]">
                Archive
              </DropdownMenuItem>
              {SNOOZE_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.days}
                  onClick={() => snooze(opt.days)}
                  className="text-[13px]"
                >
                  Snooze {opt.label.toLowerCase()}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Reply */}
          <button
            onClick={() => { setInitialDraft(""); setShowDraft(true); }}
            className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700"
          >
            Reply
          </button>
        </div>
      </div>

      {/* Summary panel */}
      <AnimatePresence>
        {(summary || isSummarizing) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-b border-zinc-100 bg-zinc-50"
          >
            <div className="px-6 py-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                Summary
              </p>
              <div className="text-[13px] leading-relaxed text-zinc-700">
                {summary
                  ? summary.split("\n").map((line, i) => (
                      <p key={i} className={line === "" ? "mt-2" : ""}>
                        {line.split(/(\*\*[^*]+\*\*)/).map((part, j) =>
                          part.startsWith("**") && part.endsWith("**")
                            ? <strong key={j}>{part.slice(2, -2)}</strong>
                            : part
                        )}
                      </p>
                    ))
                  : <span className="text-zinc-400">Thinking…</span>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-16 bg-gradient-to-t from-white to-transparent" />
        <div className="h-full overflow-y-auto px-6 py-5 space-y-4">
          {messages.map((msg, i) => (
            <EmailMessage key={msg.id} email={msg} index={i} />
          ))}
        </div>
      </div>

      {/* Draft editor */}
      <AnimatePresence>
        {showDraft && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-6 right-6 z-50 w-[520px]"
          >
            <DraftEditor
              threadId={threadId}
              threadMessages={messages}
              initialDraft={initialDraft}
              onClose={() => setShowDraft(false)}
              replyToMessageId={messages[messages.length - 1]?.id}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
