"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { type Email } from "@/lib/supabase";
import { Textarea } from "@/components/ui/textarea";
import SendLaterPicker from "@/components/compose/SendLaterPicker";
import { toast } from "sonner";
import { type VoiceProfileData } from "@/lib/voice-profile";

interface Props {
  threadId: string;
  threadMessages: Email[];
  initialDraft?: string;
  onClose: () => void;
  replyToMessageId?: string; // Gmail ID of the last message in the thread
}

function formalityLabel(score: number) {
  if (score <= 2) return "casual";
  if (score >= 4) return "formal";
  return "professional";
}

export default function DraftEditor({ threadId, threadMessages, initialDraft = "", onClose, replyToMessageId }: Props) {
  const [draft, setDraft] = useState(initialDraft);
  const [tone, setTone] = useState<"brief" | "detailed">("brief");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showSendLater, setShowSendLater] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileData | null>(null);

  useEffect(() => {
    fetch("/api/voice-profile")
      .then((r) => r.json())
      .then((d) => { if (d.profile) setVoiceProfile(d.profile as VoiceProfileData); })
      .catch(() => {});
  }, []);

  // Keep stable refs so keydown handler always calls the latest version
  const draftRef = useRef(draft);
  const isGeneratingRef = useRef(isGenerating);
  const isSendingRef = useRef(isSending);
  const handleSendRef = useRef(handleSend);
  const generateDraftRef = useRef(generateDraft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { isGeneratingRef.current = isGenerating; }, [isGenerating]);
  useEffect(() => { isSendingRef.current = isSending; }, [isSending]);
  useEffect(() => { handleSendRef.current = handleSend; });
  useEffect(() => { generateDraftRef.current = generateDraft; });

  async function generateDraft() {
    const currentDraft = draftRef.current;
    setIsGenerating(true);
    setDraft("");
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "reply",
          tone,
          currentDraft: currentDraft.trim() || undefined,
          threadMessages: threadMessages.map((m) => ({
            from: m.from_email,
            body: m.body_plain || m.snippet,
          })),
        }),
      });
      if (!res.ok || !res.body) throw new Error("Draft generation failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setDraft((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch {
      toast.error("Draft generation failed");
      setDraft(currentDraft); // restore on failure
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleSend(sendAt?: Date) {
    setIsSending(true);
    try {
      const first = threadMessages[0];
      const last = threadMessages[threadMessages.length - 1];
      const subject = first?.subject ?? "";
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: last?.from_email ?? first?.from_email ?? "",
          subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
          body: draft,
          replyToMessageId: replyToMessageId ?? last?.id,
          replyThreadId: threadId,
          ...(sendAt ? { sendAt: sendAt.toISOString() } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Send failed (${res.status})`);
      }
      toast.success(sendAt ? "Scheduled" : "Sent");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setIsSending(false);
    }
  }


  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!isSendingRef.current && draftRef.current) handleSendRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "g") {
        e.preventDefault();
        if (!isGeneratingRef.current) generateDraftRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-blue-50/60 via-white to-white shadow-[0_12px_56px_rgba(0,0,0,0.18),0_0_0_1px_rgba(59,130,246,0.15)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5">
        <span className="text-[13px] font-semibold text-zinc-900">Reply</span>
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

      {/* Body */}
      <div className="relative border-t border-zinc-100">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!isSending && draft) handleSend();
            }
          }}
          placeholder={voiceProfile ? "Write a reply… or generate one in your voice" : "Write a reply…"}
          rows={8}
          className="w-full resize-none border-0 bg-transparent px-5 pb-14 pt-4 text-[13px] leading-relaxed text-zinc-800 placeholder:text-zinc-300 focus-visible:ring-0"
        />
        <AnimatePresence>
          {isGenerating && !draft && (
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
            disabled={isGenerating}
            className={[
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all",
              !isGenerating
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
            {isGenerating ? "Generating…" : draft ? "Regenerate" : "Generate draft"}
          </motion.button>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-3">
        <span className="text-[11px] text-zinc-300">⌘G generate · ⌘↩ send</span>
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
            disabled={!draft || isSending}
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
    </div>
  );
}
