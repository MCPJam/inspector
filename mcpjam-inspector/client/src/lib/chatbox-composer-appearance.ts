import { cn } from "@/lib/utils";
import type { HostStyleFamily } from "@/lib/client-styles";

export type ChatboxComposerAppearance = {
  shellClasses: string;
  activeSubmitButtonClasses: string;
  inactiveSubmitButtonClasses: string;
};

/**
 * Visual shell for chatbox composers — shared between `ChatInput` and
 * `McpjamAgentComposer` so agent follow-ups match the playground skin.
 */
export function getChatboxComposerAppearance(
  family: HostStyleFamily | null,
  isDark: boolean,
): ChatboxComposerAppearance {
  const shellClasses =
    family === "chatgpt"
      ? cn(
          "chatbox-host-composer rounded-[1.75rem]",
          isDark
            ? "border border-white/10 bg-[#303030] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]"
            : "border border-neutral-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]",
        )
      : family === "claude"
        ? cn(
            "chatbox-host-composer rounded-[1.35rem]",
            isDark
              ? "border-[#4b463d] bg-[#30302E] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]"
              : "border border-[#DFDFDB] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]",
          )
        : "rounded-3xl border border-border/40 bg-muted/70";

  const activeSubmitButtonClasses =
    family === "chatgpt"
      ? isDark
        ? "bg-[#f4f4f4] text-[#1f1f1f] hover:bg-[#e8e8e8]"
        : "bg-[#1f1f1f] text-white hover:bg-[#303030]"
      : family === "claude"
        ? isDark
          ? "bg-[#d07b53] text-[#fff7f0] hover:bg-[#c06f49]"
          : "bg-[#e27d47] text-white hover:bg-[#d16f3d]"
        : "bg-primary text-primary-foreground hover:bg-primary/90";

  const inactiveSubmitButtonClasses =
    family === "chatgpt"
      ? isDark
        ? "bg-[#3a3a3a] text-[#8a8a8a] cursor-not-allowed"
        : "bg-[#e7e7e7] text-[#9b9b9b] cursor-not-allowed"
      : family === "claude"
        ? isDark
          ? "bg-[#45413b] text-[#8d857a] cursor-not-allowed"
          : "bg-[#ebe5dc] text-[#b6ada0] cursor-not-allowed"
        : "bg-muted text-muted-foreground cursor-not-allowed";

  return {
    shellClasses,
    activeSubmitButtonClasses,
    inactiveSubmitButtonClasses,
  };
}
