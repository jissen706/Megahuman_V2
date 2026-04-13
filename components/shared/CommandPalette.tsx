"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent } from "@/components/ui/dialog";

interface Command {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const COMMANDS: Command[] = [
    { id: "compose",  label: "Compose new email",       hint: "C",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:compose")); } },
    { id: "archive",   label: "Archive selected email",  hint: "E",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:archive")); } },
    { id: "reply",     label: "Reply to email",          hint: "R",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:reply")); } },
    { id: "summarize", label: "Summarize thread",         hint: "S",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:summarize")); } },
    { id: "inbox",    label: "Go to Inbox",             hint: "G I", action: () => { setOpen(false); router.push("/inbox"); } },
    { id: "sent",     label: "Go to Sent",              hint: "G S", action: () => { setOpen(false); router.push("/sent"); } },
    { id: "chat",     label: "Go to Chat",              hint: "G C", action: () => { setOpen(false); router.push("/chat"); } },
    { id: "sync",     label: "Sync inbox",              hint: "",    action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:sync")); } },
    { id: "tab1",     label: "Primary tab",             hint: "1",   action: () => { setOpen(false); router.push("/inbox"); window.dispatchEvent(new CustomEvent("megahuman:tab", { detail: "personal" })); } },
    { id: "tab2",     label: "Updates tab",             hint: "2",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:tab", { detail: "updates" })); } },
    { id: "tab3",     label: "Promotions tab",          hint: "3",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:tab", { detail: "promotions" })); } },
    { id: "tab4",     label: "Social tab",              hint: "4",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:tab", { detail: "social" })); } },
    { id: "tab5",     label: "Forums tab",              hint: "5",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:tab", { detail: "forums" })); } },
    { id: "tab6",     label: "Archive tab",             hint: "6",   action: () => { setOpen(false); window.dispatchEvent(new CustomEvent("megahuman:tab", { detail: "archive" })); } },
  ];

  const filtered = query.trim()
    ? COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : COMMANDS;

  useEffect(() => { setActiveIndex(0); }, [query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[activeIndex]?.action();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <DialogContent className="max-w-[420px] overflow-hidden p-0 shadow-2xl">
        <div className="border-b border-zinc-100 px-4">
          <input
            ref={inputRef}
            autoFocus
            placeholder="Search commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full py-3.5 text-[13px] text-zinc-800 placeholder:text-zinc-400 outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-zinc-400">No commands found.</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={cmd.action}
                onMouseEnter={() => setActiveIndex(i)}
                className={[
                  "flex w-full items-center justify-between px-4 py-2.5 text-left text-[13px] transition-colors",
                  i === activeIndex ? "bg-zinc-50 text-zinc-900" : "text-zinc-600",
                ].join(" ")}
              >
                {cmd.label}
                {cmd.hint && (
                  <kbd className="text-[11px] text-zinc-400 font-mono">{cmd.hint}</kbd>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
