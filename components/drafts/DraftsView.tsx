"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import DraftEditorModal from "./DraftEditorModal";

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
  updatedAt: string;
  hasAttachment: boolean;
  attachmentNames: string[];
}

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString([], { month: "short", day: "numeric" });
}

function parseName(to: string): string {
  if (!to) return "—";
  const match = to.match(/^(.+?)\s*</);
  if (match) return match[1].replace(/"/g, "").trim();
  return to.split("@")[0];
}

export default function DraftsView() {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail/drafts");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load drafts");
      setDrafts(data.drafts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(draftId: string) {
    try {
      const res = await fetch(`/api/gmail/drafts/${draftId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setDrafts((prev) => prev.filter((d) => d.draftId !== draftId));
      toast.success("Draft discarded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleSend(draftId: string) {
    try {
      const res = await fetch(`/api/gmail/drafts/${draftId}/send`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      setDrafts((prev) => prev.filter((d) => d.draftId !== draftId));
      toast.success("Sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    }
  }

  return (
    <main className="flex h-screen flex-col">
      <div className="flex items-center border-b border-zinc-100 px-6 py-3">
        <h1 className="text-[13px] font-semibold text-zinc-800">Drafts</h1>
        <span className="ml-2 text-[11px] text-zinc-400">
          {drafts.length > 0 ? `${drafts.length} waiting to send` : "Drafts live here before you send"}
        </span>
        <button
          onClick={load}
          className="ml-auto text-[11px] text-zinc-400 hover:text-zinc-700"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[12px] text-zinc-400">Loading drafts…</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1">
          <p className="text-[13px] font-medium text-zinc-700">Couldn&apos;t load drafts</p>
          <p className="text-[12px] text-zinc-400">{error}</p>
        </div>
      ) : drafts.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-1 flex-col items-center justify-center gap-2"
        >
          <p className="text-[13px] font-medium text-zinc-900">No drafts yet</p>
          <p className="max-w-xs text-center text-[12px] text-zinc-400">
            Use the chat to draft multiple emails with a resume attached, or compose a single draft.
          </p>
        </motion.div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center border-b border-zinc-100 px-6 py-2">
            <span className="w-36 shrink-0 text-[11px] font-medium uppercase tracking-wide text-zinc-400">To</span>
            <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Subject</span>
            <span className="w-28 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-zinc-400">Updated</span>
            <span className="w-40 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-zinc-400">Actions</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {drafts.map((draft, i) => (
              <motion.div
                key={draft.draftId}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: i * 0.02 }}
                className="group flex items-center border-b border-zinc-50 px-6 py-3 hover:bg-zinc-50/60 transition-colors"
              >
                <button
                  onClick={() => setSelectedDraftId(draft.draftId)}
                  className="flex flex-1 items-center text-left"
                >
                  <span className="w-36 shrink-0 truncate text-[13px] font-medium text-zinc-800">
                    {parseName(draft.to)}
                  </span>
                  <div className="flex flex-1 flex-col overflow-hidden pr-4">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] text-zinc-700">
                        {draft.subject || "(no subject)"}
                      </span>
                      {draft.hasAttachment && (
                        <span
                          title={draft.attachmentNames.join(", ")}
                          className="flex items-center gap-0.5 text-[10px] text-zinc-400 shrink-0"
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                            <path
                              d="M12 7.5V4a3 3 0 0 0-6 0v7a2 2 0 0 0 4 0V5.5"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinecap="round"
                            />
                          </svg>
                          {draft.attachmentNames[0]}
                        </span>
                      )}
                    </div>
                    {draft.snippet && (
                      <span className="truncate text-[12px] text-zinc-400">{draft.snippet}</span>
                    )}
                  </div>
                  <span className="w-28 shrink-0 text-right text-[12px] text-zinc-400">
                    {formatRelative(draft.updatedAt)}
                  </span>
                </button>
                <div className="flex w-40 shrink-0 items-center justify-end gap-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSend(draft.draftId);
                    }}
                    className="rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-zinc-800"
                  >
                    Send
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Discard this draft?")) handleDelete(draft.draftId);
                    }}
                    className="rounded-md px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                  >
                    Discard
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {selectedDraftId && (
        <DraftEditorModal
          draftId={selectedDraftId}
          onClose={() => setSelectedDraftId(null)}
          onSent={(id) => {
            setSelectedDraftId(null);
            setDrafts((prev) => prev.filter((d) => d.draftId !== id));
          }}
          onDeleted={(id) => {
            setSelectedDraftId(null);
            setDrafts((prev) => prev.filter((d) => d.draftId !== id));
          }}
          onSaved={(id, updated) => {
            setDrafts((prev) =>
              prev.map((d) => (d.draftId === id ? { ...d, ...updated } : d))
            );
          }}
        />
      )}
    </main>
  );
}
