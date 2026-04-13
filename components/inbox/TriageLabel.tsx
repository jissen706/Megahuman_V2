import { type TriageLabel as TriageLabelType } from "@/lib/supabase";

const CONFIG: Record<TriageLabelType, { label: string; className: string }> = {
  urgent: {
    label: "urgent",
    className: "bg-red-50 text-red-500 ring-red-100",
  },
  needs_reply: {
    label: "reply",
    className: "bg-amber-50 text-amber-600 ring-amber-100",
  },
  fyi: {
    label: "fyi",
    className: "bg-sky-50 text-sky-500 ring-sky-100",
  },
  newsletter: {
    label: "list",
    className: "bg-zinc-100 text-zinc-400 ring-zinc-200",
  },
};

export default function TriageLabel({ label }: { label: TriageLabelType }) {
  const config = CONFIG[label];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${config.className}`}>
      {config.label}
    </span>
  );
}
