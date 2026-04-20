"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";

interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
}

interface DraftDetail {
  draftId: string;
  messageId: string;
  to: string;
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
  attachments: Attachment[];
}

interface Props {
  draftId: string;
  onClose: () => void;
  onSent: (draftId: string) => void;
  onDeleted: (draftId: string) => void;
  onSaved: (draftId: string, updated: { to: string; subject: string; snippet: string }) => void;
}

// Strip the tracking pixel & basic HTML so the user edits plain text
function htmlToPlain(html: string): string {
  return html
    .replace(/<img[^>]*\/api\/track\/[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

export default function DraftEditorModal({
  draftId,
  onClose,
  onSent,
  onDeleted,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/gmail/drafts/${draftId}`);
        const data = await res.json();
        if (cancel) return;
        if (!res.ok) throw new Error(data.error || "Failed to load draft");
        const d = data.draft as DraftDetail;
        setDraft(d);
        setTo(d.to);
        setSubject(d.subject);
        setBody(d.bodyPlain?.trim() || htmlToPlain(d.bodyHtml));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Load failed");
        onClose();
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [draftId, onClose]);

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(`/api/gmail/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Save failed");
      }
      onSaved(draftId, { to, subject, snippet: body.slice(0, 120) });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSend() {
    // Save pending edits first so the sent email has the current text
    if (draft && (to !== draft.to || subject !== draft.subject || body !== (draft.bodyPlain?.trim() || htmlToPlain(draft.bodyHtml)))) {
      const ok = await save();
      if (!ok) return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/gmail/drafts/${draftId}/send`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      toast.success("Sent");
      onSent(draftId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Discard this draft?")) return;
    try {
      const res = await fetch(`/api/gmail/drafts/${draftId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Discarded");
      onDeleted(draftId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const canSend = !!to && !!body && !sending && !saving && !loading;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="relative z-50 flex w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_12px_56px_rgba(0,0,0,0.22),0_0_0_1px_rgba(0,0,0,0.05)]"
        >
          <div className="flex items-center gap-3 px-5 py-3.5">
            <span className="text-[13px] font-semibold text-zinc-900">Edit draft</span>
            <button
              onClick={onClose}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {loading ? (
            <div className="flex min-h-[200px] items-center justify-center">
              <span className="text-[12px] text-zinc-400">Loading…</span>
            </div>
          ) : (
            <>
              <div className="flex flex-col border-t border-zinc-100">
                <div className="flex items-center gap-3 px-5 py-2">
                  <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    To
                  </span>
                  <input
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="flex-1 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 outline-none"
                  />
                </div>
                <div className="flex items-center gap-3 border-t border-zinc-100 px-5 py-2">
                  <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Subj
                  </span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="flex-1 py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-300 outline-none"
                  />
                </div>
              </div>

              <div className="border-t border-zinc-100">
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  className="w-full resize-none px-5 py-4 text-[13px] leading-relaxed text-zinc-800 placeholder:text-zinc-300 outline-none"
                />
              </div>

              {draft && draft.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 border-t border-zinc-100 px-5 py-2">
                  {draft.attachments.map((a) => (
                    <span
                      key={a.filename}
                      className="flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600"
                    >
                      <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M12 7.5V4a3 3 0 0 0-6 0v7a2 2 0 0 0 4 0V5.5"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                        />
                      </svg>
                      {a.filename}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-3">
                <button
                  onClick={handleDelete}
                  className="text-[12px] text-zinc-400 transition-colors hover:text-red-600"
                >
                  Discard
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={save}
                    disabled={saving || sending}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800 disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="rounded-lg bg-zinc-900 px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
