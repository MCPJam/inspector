/**
 * The middle panel of the Production Redesign chrome (BB-127): the off-white
 * working surface that sits inset in the linen sidebar/top-bar frame.
 *
 * Its own module rather than a local in `App.tsx` so the visibility rule can be
 * tested without standing up the whole app graph. Pure presentation — the only
 * thing it reads is whether the viewport is mobile.
 *
 * The 16px top radius + shadow only make sense with the top bar above them, so
 * they mirror `AppChromeHeader`'s visibility rule exactly (hidden on Home for
 * signed-in users and during playground onboarding, but always shown on
 * mobile). Without that guard the rounded corners would cut into the very top
 * of the viewport and read as a rendering bug.
 */
import type { ReactNode } from "react";

import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function AppChromePanel({
  headerHidden,
  children,
}: {
  headerHidden: boolean;
  children: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const headerVisible = !headerHidden || isMobile;

  return (
    <div
      data-testid="app-chrome-panel"
      className={cn(
        "bg-background flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        // rounded-t-2xl is 16px; it is not remapped by the theme's radius
        // scale (only sm/md/lg/xl are), so it tracks the design value.
        headerVisible && "rounded-t-2xl shadow-[0_2px_3px_#00000033]"
      )}
    >
      {children}
    </div>
  );
}
