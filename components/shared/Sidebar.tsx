"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import ComposeModal from "@/components/compose/ComposeModal";
import { toast } from "sonner";

const NAV = [
  { href: "/inbox", label: "Inbox" },
  { href: "/sent",  label: "Sent" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeContext, setComposeContext] = useState<{
    to?: string; recipientName?: string; threadMessages?: Array<{ from: string; body: string }>;
  } | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);

  async function handleSync(silent = false) {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      if (!silent) toast.success(`Synced ${data.synced} emails`);
      router.refresh();
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
      syncingRef.current = false;
    }
  }

  // Auto-sync on mount and every 5 minutes
  useEffect(() => {
    // Backfill to_email for existing sent emails (no-op if already populated)
    fetch("/api/gmail/backfill-to", { method: "POST" }).catch(() => {});
    handleSync(true);
    const interval = setInterval(() => handleSync(true), 5 * 60 * 1000);
    const onSyncEvent = () => handleSync(false);
    const onComposeEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? undefined;
      setComposeContext(detail);
      setComposeOpen(true);
    };
    window.addEventListener("megahuman:sync", onSyncEvent);
    window.addEventListener("megahuman:compose", onComposeEvent);
    return () => {
      clearInterval(interval);
      window.removeEventListener("megahuman:sync", onSyncEvent);
      window.removeEventListener("megahuman:compose", onComposeEvent);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const NAV_ITEMS = [
    {
      href: "/inbox", label: "Inbox",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 4h12v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
          <path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      href: "/sent", label: "Sent",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M14 2L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <path d="M14 2L9.5 13.5 7 9 2.5 6.5 14 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      href: "/chat", label: "Chat",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 1C4.13 1 1 3.8 1 7.25c0 1.94 1.03 3.66 2.63 4.78-.06.72-.35 1.73-.96 2.72 0 0 1.87-.25 3.43-1.17.6.15 1.23.22 1.9.22 3.87 0 7-2.8 7-6.25S11.87 1 8 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        </svg>
      ),
    },
  ];

  return (
    <>
      <aside className="flex w-[188px] shrink-0 flex-col border-r border-zinc-100 bg-white px-3 py-4">
        {/* Compose */}
        <button
          onClick={() => setComposeOpen(true)}
          className="mb-4 flex items-center gap-2 rounded-md bg-zinc-100 px-2.5 py-2 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-200 hover:text-zinc-900"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 2H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M10.5 1.5a1.121 1.121 0 0 1 2 1L8 7l-2.5.5L6 5l4.5-3.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
          </svg>
          Compose
          <kbd className="ml-auto text-[10px] font-normal text-zinc-400">C</kbd>
        </button>

        {/* Nav */}
        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ href, label, icon }) => {
            const active = pathname === href || (href !== "/" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                onMouseDown={(e) => e.preventDefault()}
                className={[
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
                  active
                    ? "bg-zinc-100 font-medium text-zinc-900"
                    : "text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700",
                ].join(" ")}
              >
                {icon}
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* Sync */}
        <button
          onClick={() => handleSync(false)}
          disabled={syncing}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-600 disabled:opacity-40"
        >
          <motion.svg
            width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0"
            animate={syncing ? { rotate: 360 } : { rotate: 0 }}
            transition={syncing ? { duration: 1, repeat: Infinity, ease: "linear" } : {}}
          >
            <path d="M10 6A4 4 0 1 1 6 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M9 1l1 1-1 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </motion.svg>
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </aside>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} context={composeContext} />
    </>
  );
}
