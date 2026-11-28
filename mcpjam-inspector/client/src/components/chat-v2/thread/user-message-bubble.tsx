/**
 * UserMessageBubble
 *
 * Reusable user message component that displays text in a chat bubble.
 * Used by both ChatTabV2's Thread and the UI Playground for consistent styling.
 */

import {
  useScenarioHostStyle,
  useScenarioHostTheme,
} from "@/contexts/scenario-client-style-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { usePlaygroundTerminalPresentation } from "@/contexts/playground-terminal-presentation";
import { getScenarioHostFamily } from "@/lib/scenario-client-style";
import { cn } from "@/lib/utils";

interface UserMessageBubbleProps {
  children: React.ReactNode;
  className?: string;
}

export function UserMessageBubble({
  children,
  className = "",
}: UserMessageBubbleProps) {
  const scenarioHostStyle = useScenarioHostStyle();
  const scenarioHostTheme = useScenarioHostTheme();
  const globalThemeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedThemeMode = scenarioHostTheme ?? globalThemeMode;
  const isDarkScenarioTheme = resolvedThemeMode === "dark";
  const terminal = usePlaygroundTerminalPresentation();
  if (terminal) {
    return (
      <div
        data-terminal-client={terminal.variant}
        className={cn(
          "flex max-h-[70vh] w-full min-w-0 gap-2 overflow-auto overscroll-contain bg-muted px-2 py-1.5 font-mono text-[13px] leading-5 text-foreground",
          className,
        )}
      >
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          {terminal.prompt}
        </span>
        <div className="min-w-0 flex-1 space-y-3">{children}</div>
      </div>
    );
  }
  const scenarioHostFamily = getScenarioHostFamily(scenarioHostStyle);
  const bubbleClasses =
    scenarioHostFamily === "chatgpt"
      ? cn(
          "scenario-host-user-bubble rounded-[1.5rem] border-transparent shadow-none",
          isDarkScenarioTheme
            ? "bg-[#303030] text-[#DFDFDF]"
            : "bg-[#f4f4f4] text-[#1f1f1f]",
        )
      : scenarioHostFamily === "claude"
        ? cn(
            "scenario-host-user-bubble rounded-xl shadow-none",
            isDarkScenarioTheme
              ? "border-[#4c473f] bg-[#141413] text-[#F1F0ED]"
              : "border-[#d9d1c5] bg-[#f5f0e8] text-[#2d2926]",
          )
        : "rounded-xl border border-[#e5e7ec] bg-[#f9fafc] text-[#1f2733] shadow-sm dark:border-[#4a5261] dark:bg-[#2f343e] dark:text-[#e6e8ed]";

  return (
    <div className={cn("flex w-full min-w-0 justify-end", className)}>
      <div
        className={cn(
          "max-h-[70vh] max-w-[min(100%,48rem)] space-y-3 overflow-auto overscroll-contain px-4 py-3 text-sm leading-6",
          bubbleClasses,
        )}
      >
        {children}
      </div>
    </div>
  );
}
