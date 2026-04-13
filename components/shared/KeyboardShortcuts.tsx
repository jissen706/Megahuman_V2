"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Global keyboard shortcut handler.
 * j/k — navigate inbox (handled in InboxList)
 * c   — compose new email
 * g i — go to inbox
 * g s — go to sent
 *
 * Note: j/k/e/r shortcuts are handled locally in InboxList to access selectedIndex state.
 * Only global navigation shortcuts live here.
 */
export default function KeyboardShortcuts() {
  const router = useRouter();

  useEffect(() => {
    let pendingG = false;

    function onKeyDown(e: KeyboardEvent) {
      // Skip if user is typing in an input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (pendingG) {
        pendingG = false;
        if (e.key === "i") router.push("/inbox");
        if (e.key === "s") router.push("/sent");
        if (e.key === "c") router.push("/chat");
        return;
      }

      if (e.key === "g") {
        pendingG = true;
        setTimeout(() => { pendingG = false; }, 1000);
        return;
      }

      if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        // TODO: trigger compose modal open — use a global store or custom event
        window.dispatchEvent(new CustomEvent("megahuman:compose"));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
