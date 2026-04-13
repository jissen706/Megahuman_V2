"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { type Email } from "@/lib/supabase";
import ThreadRow from "./ThreadRow";

interface Props {
  emails: Email[];
}

type Tab = "personal" | "updates" | "promotions" | "social" | "forums" | "archive";

const TABS: { id: Tab; label: string; labels: (string | null)[] }[] = [
  { id: "personal",   label: "Primary",    labels: ["personal", null] },
  { id: "updates",    label: "Updates",    labels: ["updates"] },
  { id: "promotions", label: "Promotions", labels: ["promotions"] },
  { id: "social",     label: "Social",     labels: ["social"] },
  { id: "forums",     label: "Forums",     labels: ["forums"] },
  { id: "archive",    label: "Archive",    labels: [] },
];

const EMPTY: Record<Tab, string> = {
  personal:   "All caught up",
  updates:    "No updates",
  promotions: "No promotions",
  social:     "No social",
  forums:     "No forums",
  archive:    "No archived emails",
};

const PAGE_SIZE = 15;
const readCache = new Set<string>();

export default function InboxList({ emails }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("personal");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, forceUpdate] = useState(0);
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [archivedEmails, setArchivedEmails] = useState<Email[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const archivedFetched = useRef(false);

  function markRead(id: string) {
    readCache.add(id);
    forceUpdate((n) => n + 1);
  }

  async function archive(email: Email) {
    setArchived((prev) => new Set(prev).add(email.id));
    setSelectedIndex((i) => Math.max(i - 1, 0));
    try {
      const res = await fetch(`/api/emails/${email.id}/archive`, { method: "POST" });
      if (!res.ok) throw new Error();
    } catch {
      setArchived((prev) => { const s = new Set(prev); s.delete(email.id); return s; });
      toast.error("Archive failed");
    }
  }

  async function unarchive(email: Email) {
    setArchivedEmails((prev) => prev.filter((e) => e.id !== email.id));
    setSelectedIndex((i) => Math.max(i - 1, 0));
    try {
      const res = await fetch(`/api/emails/${email.id}/unarchive`, { method: "POST" });
      if (!res.ok) throw new Error();
      toast.success("Moved to inbox");
    } catch {
      setArchivedEmails((prev) => [...prev, email]);
      toast.error("Unarchive failed");
    }
  }

  useEffect(() => {
    if (tab !== "archive" || archivedFetched.current) return;
    archivedFetched.current = true;
    setArchivedLoading(true);
    fetch("/api/emails/archived")
      .then((r) => r.json())
      .then((data) => setArchivedEmails(Array.isArray(data) ? data : []))
      .catch(() => toast.error("Failed to load archive"))
      .finally(() => setArchivedLoading(false));
  }, [tab]);

  const NON_PRIMARY_LABELS = new Set(["updates", "promotions", "social", "forums"]);

  function poolFor(t: Tab) {
    if (t === "archive") return archivedEmails;
    if (t === "personal") {
      // Catch-all: anything not explicitly in another category
      return emails.filter((e) => !NON_PRIMARY_LABELS.has(e.triage_label ?? ""));
    }
    const { labels } = TABS.find((x) => x.id === t)!;
    return emails.filter((e) => labels.includes(e.triage_label as string | null));
  }

  const pool = poolFor(tab).filter((e) => !archived.has(e.id));
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visible = pool.slice(0, visibleCount);
  const hasMore = visibleCount < pool.length;

  useEffect(() => {
    setSelectedIndex(0);
    setVisibleCount(PAGE_SIZE);
  }, [tab]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Navigation
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      }

      // Open selected email
      else if (e.key === "Enter" || e.key === "o") {
        const email = visible[selectedIndex];
        if (email) {
          markRead(email.id);
          router.push(`/thread/${email.thread_id}`);
        }
      }

      // Archive / unarchive selected email
      else if (e.key === "e") {
        const email = visible[selectedIndex];
        if (email) {
          if (tab === "archive") unarchive(email);
          else archive(email);
        }
      }

      // Unarchive from archive tab
      else if (e.key === "u") {
        if (tab === "archive") {
          const email = visible[selectedIndex];
          if (email) unarchive(email);
        }
      }

      // Switch tabs with left/right arrow keys
      else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setTab((t) => { const i = TABS.findIndex((x) => x.id === t); return TABS[Math.max(i - 1, 0)].id; });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setTab((t) => { const i = TABS.findIndex((x) => x.id === t); return TABS[Math.min(i + 1, TABS.length - 1)].id; });
      }

      // Switch tabs with number keys
      else if (e.key === "1") setTab("personal");
      else if (e.key === "2") setTab("updates");
      else if (e.key === "3") setTab("promotions");
      else if (e.key === "4") setTab("social");
      else if (e.key === "5") setTab("forums");
      else if (e.key === "6") setTab("archive");
    },
    [visible, selectedIndex, router]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    function onArchiveEvent() {
      const email = visible[selectedIndex];
      if (email) archive(email);
    }
    window.addEventListener("megahuman:archive", onArchiveEvent);
    return () => window.removeEventListener("megahuman:archive", onArchiveEvent);
  }, [visible, selectedIndex]);

  useEffect(() => {
    function onTabEvent(e: Event) {
      const tab = (e as CustomEvent).detail as Tab;
      if (TABS.find((t) => t.id === tab)) setTab(tab);
    }
    window.addEventListener("megahuman:tab", onTabEvent);
    return () => window.removeEventListener("megahuman:tab", onTabEvent);
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center border-b border-zinc-100 px-6">
        {TABS.map((t) => {
          const count = poolFor(t.id).length;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={[
                "relative mr-5 flex items-center gap-1.5 py-3 text-[12.5px] transition-colors duration-100 last:mr-0",
                active ? "font-medium text-zinc-900" : "font-normal text-zinc-400 hover:text-zinc-600",
              ].join(" ")}
            >
              {t.label}
              {count > 0 && (
                <span className={[
                  "text-[11px] tabular-nums",
                  active ? "text-zinc-500" : "text-zinc-300",
                ].join(" ")}>
                  {count}
                </span>
              )}
              {active && (
                <span className="absolute inset-x-0 bottom-0 h-px bg-zinc-900" />
              )}
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="relative flex-1 overflow-hidden">
        {/* Bottom fade — floats above scroll content, hints at more below */}
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-16 bg-gradient-to-t from-white to-transparent" />
        <div className="h-full overflow-y-auto">
        <AnimatePresence mode="wait">
          {archivedLoading ? (
            <motion.div
              key="archive-loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="flex flex-1 flex-col items-center justify-center gap-1.5 py-24"
            >
              <p className="text-[13px] text-zinc-400">Loading…</p>
            </motion.div>
          ) : visible.length === 0 ? (
            <motion.div
              key={`empty-${tab}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="flex flex-1 flex-col items-center justify-center gap-1.5 py-24"
            >
              <p className="text-[13px] font-semibold text-zinc-700">{EMPTY[tab]}</p>
            </motion.div>
          ) : (
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              {visible.map((email, i) => (
                <ThreadRow
                  key={email.id}
                  email={email}
                  isSelected={selectedIndex === i}
                  index={i}
                  isRead={email.is_read || readCache.has(email.id)}
                  onRead={() => markRead(email.id)}
                  action={tab === "archive" ? {
                    label: "Move to inbox",
                    onClick: (e) => { e.stopPropagation(); unarchive(email); },
                  } : undefined}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {hasMore && (
          <div className="flex justify-center py-5">
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="rounded-full border border-zinc-200 px-4 py-1.5 text-[12px] font-medium text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800"
            >
              Load more
            </button>
          </div>
        )}

        {/* Keyboard hint */}
        <div className="flex items-center gap-3 border-t border-zinc-50 px-6 py-2.5">
          {[
            ["j/k", "navigate"],
            ["↩", "open"],
            ["e", tab === "archive" ? "move to inbox" : "archive"],
            ["r", "reply"],
            ["c", "compose"],
            ["1–6", "tabs"],
          ].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1 text-[11px] text-zinc-300">
              <kbd className="font-mono">{key}</kbd>
              <span>{label}</span>
            </span>
          ))}
        </div>
        </div>{/* end inner scroll div */}
      </div>
    </div>
  );
}
