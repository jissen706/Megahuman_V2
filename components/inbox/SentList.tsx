"use client";

import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { type Email } from "@/lib/supabase";

interface SentEmail extends Email {
  opened_at?: string | null;
}

interface Props {
  emails: SentEmail[];
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

function ReadReceiptBadge({ openedAt }: { openedAt: string | null | undefined }) {
  if (openedAt) {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span className="text-[11px] text-emerald-600 font-medium whitespace-nowrap">
          Opened {formatRelative(openedAt)}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
      <span className="text-[11px] text-zinc-400 whitespace-nowrap">Not opened</span>
    </div>
  );
}

function getRecipientName(toEmail: string | null | undefined): string {
  if (!toEmail) return "—";
  const match = toEmail.match(/^(.+?)\s*</);
  return match ? match[1].replace(/"/g, "").trim() : toEmail.split("@")[0];
}

export default function SentList({ emails }: Props) {
  const router = useRouter();
  if (emails.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-1 flex-col items-center justify-center gap-2"
      >
        <p className="text-[13px] font-medium text-zinc-900">Nothing sent yet</p>
        <p className="text-[13px] text-zinc-400">Emails you send will appear here.</p>
      </motion.div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Column header */}
      <div className="flex items-center border-b border-zinc-100 px-6 py-2">
        <span className="w-36 shrink-0 text-[11px] font-medium uppercase tracking-wide text-zinc-400">To</span>
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Subject</span>
        <span className="w-32 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-zinc-400">Sent</span>
        <span className="w-36 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-zinc-400">Read receipt</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {emails.map((email, i) => (
          <motion.div
            key={email.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: i * 0.03 }}
            onClick={() => router.push(`/thread/${email.thread_id}`)}
            className="flex cursor-pointer items-center border-b border-zinc-50 px-6 py-3 hover:bg-zinc-50/60 transition-colors"
          >
            <span className="w-36 shrink-0 truncate text-[13px] font-medium text-zinc-800">
              {getRecipientName(email.to_email)}
            </span>
            <div className="flex flex-1 flex-col overflow-hidden pr-4">
              <span className="truncate text-[13px] text-zinc-700">{email.subject || "(no subject)"}</span>
              {email.snippet && (
                <span className="truncate text-[12px] text-zinc-400">{email.snippet}</span>
              )}
            </div>
            <span className="w-32 shrink-0 text-right text-[12px] text-zinc-400">
              {new Date(email.received_at).toLocaleString([], {
                month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit",
              })}
            </span>
            <div className="w-36 shrink-0 flex justify-end">
              <ReadReceiptBadge openedAt={email.opened_at} />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
