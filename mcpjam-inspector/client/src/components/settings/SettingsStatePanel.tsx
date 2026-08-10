import type { ReactNode } from "react";

/**
 * Panel for a Settings section that has no content to show yet — loading, a
 * sign-in gate, or a missing record. It sits inside `SettingsPageShell` rather
 * than replacing the page, so the tab strip survives: a section that swaps the
 * whole surface for a lone button leaves nowhere to go but the back button.
 */
export function SettingsStatePanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-border/60 px-6 py-16 text-center">
      {children}
    </div>
  );
}
