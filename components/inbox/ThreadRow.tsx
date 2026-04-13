"use client";

import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { type Email } from "@/lib/supabase";

interface Props {
  email: Email;
  isSelected: boolean;
  index: number;
  isRead?: boolean;
  onRead?: () => void;
  action?: { label: string; onClick: (e: React.MouseEvent) => void };
}


function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isThisYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(isThisYear ? {} : { year: "numeric" }) });
}

function getSenderName(fromEmail: string) {
  const match = fromEmail.match(/^(.+?)\s*</);
  return match ? match[1].replace(/"/g, "").trim() : fromEmail.split("@")[0];
}

const TRIAGE_BAR: Record<string, string> = {
  urgent:      "bg-red-400",
  needs_reply: "bg-amber-400",
  fyi:         "bg-sky-400",
  newsletter:  "bg-zinc-300",
};

export default function ThreadRow({ email, isSelected, index, isRead, onRead, action }: Props) {
  const router = useRouter();
  const isUnread = !(isRead ?? email.is_read);
  const senderName = getSenderName(email.from_email);
  const triageBar = email.triage_label ? TRIAGE_BAR[email.triage_label] : null;

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, delay: Math.min(index * 0.018, 0.25) }}
      onClick={() => { onRead?.(); router.push(`/thread/${email.thread_id}`); }}
      className={[
        "group relative flex w-full flex-col gap-1 px-6 py-3.5 text-left transition-colors duration-75",
        isSelected
          ? "[box-shadow:0_0_0_1px_rgba(96,165,250,0.7),0_0_20px_6px_rgba(59,130,246,0.18),0_0_40px_10px_rgba(59,130,246,0.08)]"
          : "hover:[box-shadow:0_0_0_1px_rgba(96,165,250,0.55),0_0_20px_6px_rgba(59,130,246,0.15),0_0_40px_10px_rgba(59,130,246,0.06)]",
      ].join(" ")}
    >
      {/* Triage color bar */}
      {triageBar && (
        <span className={`absolute inset-y-2 left-0 w-[2px] rounded-r-full transition-opacity ${triageBar} ${isSelected ? "opacity-100" : "opacity-30"}`} />
      )}

      {/* Top row: sender + date + optional action */}
      <div className="flex items-baseline justify-between gap-4">
        <span className={[
          "truncate text-[13px] leading-snug",
          isUnread ? "font-semibold text-zinc-900" : "font-normal text-zinc-500",
        ].join(" ")}>
          {senderName}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {action && (
            <button
              onClick={action.onClick}
              className="hidden group-hover:inline text-[11px] text-zinc-400 transition-colors hover:text-zinc-700"
            >
              {action.label}
            </button>
          )}
          <span className={[
            "text-[11px] tabular-nums",
            isUnread ? "text-zinc-500" : "text-zinc-400",
          ].join(" ")}>
            {formatDate(email.received_at)}
          </span>
        </div>
      </div>

      {/* Bottom row: subject + snippet */}
      <div className="flex items-baseline gap-2 overflow-hidden">
        <span className={[
          "shrink-0 truncate text-[12.5px] leading-snug",
          isUnread ? "font-medium text-zinc-800" : "text-zinc-400",
        ].join(" ")} style={{ maxWidth: "50%" }}>
          {email.subject || "(no subject)"}
        </span>
        {email.snippet && (
          <span className="truncate text-[12px] text-zinc-400/70 leading-snug">
            {email.snippet}
          </span>
        )}
      </div>
    </motion.button>
  );
}
