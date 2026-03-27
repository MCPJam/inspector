/**
 * UserMessageBubble
 *
 * Reusable user message component that displays text in a chat bubble.
 * Used by both ChatTabV2's Thread and the UI Playground for consistent styling.
 */

import {
  useSandboxHostStyle,
  useSandboxHostTheme,
} from "@/contexts/sandbox-host-style-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

interface UserMessageBubbleProps {
  children: React.ReactNode;
  className?: string;
}

export function UserMessageBubble({
  children,
  className = "",
}: UserMessageBubbleProps) {
  const sandboxHostStyle = useSandboxHostStyle();
  const sandboxHostTheme = useSandboxHostTheme();
  const globalThemeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedThemeMode = sandboxHostTheme ?? globalThemeMode;
  const isDarkSandboxTheme = resolvedThemeMode === "dark";
  const bubbleClasses =
    sandboxHostStyle === "chatgpt"
      ? cn(
          "sandbox-host-user-bubble rounded-[1.5rem] border-transparent shadow-none",
          isDarkSandboxTheme
            ? "bg-[#2f2f2f] text-[#f5f5f5]"
            : "bg-[#f4f4f4] text-[#1f1f1f]",
        )
      : sandboxHostStyle === "claude"
        ? cn(
            "sandbox-host-user-bubble rounded-xl shadow-none",
            isDarkSandboxTheme
              ? "border-[#4c473f] bg-[#3a3832] text-[#f2ede6]"
              : "border-[#d9d1c5] bg-[#f5f0e8] text-[#2d2926]",
          )
        : "rounded-xl border border-[#e5e7ec] bg-[#f9fafc] text-[#1f2733] shadow-sm dark:border-[#4a5261] dark:bg-[#2f343e] dark:text-[#e6e8ed]";

  return (
    <div className={`flex justify-end ${className}`}>
      <div
        className={`max-w-3xl max-h-[70vh] space-y-3 overflow-auto overscroll-contain px-4 py-3 text-sm leading-6 ${bubbleClasses}`}
      >
        {children}
      </div>
    </div>
  );
}
