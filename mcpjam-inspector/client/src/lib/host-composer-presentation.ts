import { cn } from "@/lib/chat-utils";
import { getScenarioHostFamily } from "@/lib/scenario-client-style";

/** Pure shared composer appearance; no session, model or execution ownership. */
export function hostComposerClasses(
  hostStyle: string | null | undefined,
  dark: boolean,
) {
  return getScenarioHostFamily(hostStyle) === "chatgpt"
    ? cn(
        "scenario-host-composer rounded-[1.75rem]",
        dark
          ? "border border-white/10 bg-[#303030] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]"
          : "border border-neutral-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]",
      )
    : getScenarioHostFamily(hostStyle) === "claude"
      ? cn(
          "scenario-host-composer rounded-[1.35rem]",
          dark
            ? "border-[#4b463d] bg-[#30302E] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]"
            : "border border-[#DFDFDB] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]",
        )
      : "rounded-3xl border border-border/40 bg-muted/70";
}
