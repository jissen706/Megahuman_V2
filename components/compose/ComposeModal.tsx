"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import SendLaterPicker from "./SendLaterPicker";
import { toast } from "sonner";
import { type VoiceProfileData } from "@/lib/voice-profile";

interface ComposeContext {
  to?: string;
  recipientName?: string;
  threadMessages?: Array<{ from: string; body: string }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context?: ComposeContext;
}

function parseNameFromEmail(raw: string): string {
  const match = raw.match(/^(.+?)\s*</);
  if (match) return match[1].replace(/"/g, "").trim();
  return raw.split("@")[0];
}

export default function ComposeModal({ open, onClose, context }: Props) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [tone, setTone] = useState<"brief" | "detailed">("brief");
  const [showSendLater, setShowSendLater] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileData | null>(null);
  const toRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/voice-profile")
      .then((r) => r.json())
      .then((d) => { if (d.profile) setVoiceProfile(d.profile as VoiceProfileData); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) {
      setTo(context?.to ?? "");
      setSubject("");
      setBody("");
      setShowSendLater(false);
      setTimeout(() => {
        if (context?.to) {
          // To is pre-filled — focus subject instead
          const subjectEl = document.querySelector<HTMLInputElement>("[data-compose-subject]");
          subjectEl?.focus();
        } else {
          toRef.current?.focus();
        }
      }, 80);
    }
  }, [open]);

  async function generateDraft() {
    if (!subject && !to) return;
    setIsGenerating(true);
    const notes = body;
    setBody("");
    const recipientName = context?.recipientName || parseNameFromEmail(to);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "compose",
          tone,
          composeContext: {
            to,
            subject,
            notes,
            recipientName,
            threadMessages: context?.threadMessages,
          },
        }),
      });
      if (!res.ok || !res.body) throw new Error();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let subjectParsed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        if (!subjectParsed) {
          buffer += chunk;
          const newlineIdx = buffer.indexOf("\n");
          if (newlineIdx !== -1) {
            subjectParsed = true;
            const firstLine = buffer.slice(0, newlineIdx).trim();
            if (!subject && firstLine.startsWith("Subject:")) {
              setSubject(firstLine.replace(/^Subject:\s*/i, "").trim());
              setBody(buffer.slice(newlineIdx + 1).trimStart());
            } else {
              setBody(buffer);
            }
            buffer = "";
          }
        } else {
          setBody((prev) => prev + chunk);
        }
      }
      // Flush any remaining buffer (no newline found)
      if (buffer) setBody(buffer);
    } catch {
      toast.error("Draft generation failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleSend(sendAt?: Date) {
    setIsSending(true);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body, ...(sendAt ? { sendAt: sendAt.toISOString() } : {}) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Send failed`);
      }
      toast.success(sendAt ? "Scheduled" : "Sent");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setIsSending(false);
    }
  }

  const canGenerate = !isGenerating && (!!to || !!subject);
  const canSend = !!to && !!body && !isSending;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-6 right-6 z-50 flex w-[520px] flex-col overflow-hidden rounded-2xl bg-gradient-to-br from-pink-50/80 via-white to-white shadow-[0_12px_56px_rgba(0,0,0,0.18),0_0_0_1px_rgba(236,72,153,0.12)]"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-3.5">
            <span className="text-[13px] font-semibold text-zinc-900">New message</span>
            <div className="flex gap-px rounded-full border border-zinc-200 p-0.5">
              {(["brief", "detailed"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={[
                    "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    tone === t ? "bg-zinc-900 text-white" : "text-zinc-400 hover:text-zinc-700",
                  ].join(" ")}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={onClose}
                className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Fields */}
          <div className="flex flex-col border-t border-zinc-100">
            <div className="flex items-center gap-3 px-5 py-2">
              <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">To</span>
              <input
                ref={toRef}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="recipient@example.com"
                className="flex-1 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 outline-none"
              />
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-100 px-5 py-2">
              <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Subj</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                data-compose-subject
                placeholder="Subject line"
                className="flex-1 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 outline-none"
              />
            </div>
          </div>

          {/* Body */}
          <div className="relative border-t border-zinc-100">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (canSend) handleSend();
                }
              }}
              placeholder={voiceProfile ? "Jot rough notes or write freely — AI will match your voice…" : "Write your message…"}
              rows={10}
              className="w-full resize-none px-5 pb-14 pt-4 text-[13px] leading-relaxed text-zinc-800 placeholder:text-zinc-300 outline-none"
            />
            <AnimatePresence>
              {isGenerating && !body && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [1, 0, 1] }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.65, repeat: Infinity }}
                  className="pointer-events-none absolute left-5 top-4 text-[13px] text-zinc-300"
                >
                  |
                </motion.span>
              )}
            </AnimatePresence>
            <div className="absolute bottom-3.5 right-4">
              <motion.button
                whileTap={{ scale: 0.94 }}
                onClick={generateDraft}
                disabled={!canGenerate}
                className={[
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all",
                  canGenerate
                    ? "bg-zinc-900 text-white shadow-sm hover:bg-zinc-800"
                    : "bg-zinc-100 text-zinc-400",
                ].join(" ")}
              >
                <motion.span
                  animate={isGenerating ? { opacity: [1, 0.3, 1] } : {}}
                  transition={isGenerating ? { duration: 0.8, repeat: Infinity } : {}}
                >
                  ✦
                </motion.span>
                {isGenerating ? "Generating…" : body ? "Regenerate" : "Generate draft"}
              </motion.button>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-3">
            <button
              onClick={onClose}
              className="text-[12px] text-zinc-400 transition-colors hover:text-zinc-600"
            >
              Discard
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSendLater(true)}
                disabled={isSending}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800 disabled:opacity-40"
              >
                Send later
              </button>
              <button
                onClick={() => handleSend()}
                disabled={!canSend}
                className="rounded-lg bg-zinc-900 px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-40"
              >
                {isSending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>

          <AnimatePresence>
            {showSendLater && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.12 }}
                className="border-t border-zinc-100 px-5 pb-4 pt-3"
              >
                <SendLaterPicker
                  onSelect={(date) => { handleSend(date); setShowSendLater(false); }}
                  onCancel={() => setShowSendLater(false)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
