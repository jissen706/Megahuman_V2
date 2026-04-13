import Sidebar from "@/components/shared/Sidebar";
import CommandPalette from "@/components/shared/CommandPalette";
import KeyboardShortcuts from "@/components/shared/KeyboardShortcuts";
import { Toaster } from "@/components/ui/sonner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-white text-zinc-900 antialiased">
      <Sidebar />
      {/* Subtle radial glow from top-right — gives page a soft light-source feel */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_70%_0%,rgba(99,102,241,0.04),transparent)] z-0" />
        <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>
      <CommandPalette />
      <KeyboardShortcuts />
      <Toaster
        position="bottom-center"
        toastOptions={{
          classNames: {
            toast: "text-[13px] font-medium rounded-lg shadow-lg border border-zinc-100",
          },
        }}
      />
    </div>
  );
}
