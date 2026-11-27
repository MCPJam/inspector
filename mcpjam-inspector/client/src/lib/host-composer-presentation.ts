import { cn } from "@/lib/chat-utils";
import {
  CHATGPT_COMPOSER_CLASSES,
  CLAUDE_COMPOSER_CLASSES,
} from "@/lib/client-styles";
import { getScenarioHostFamily } from "@/lib/scenario-client-style";

/** Pure shared composer appearance; no session, model or execution ownership. */
export function hostComposerClasses(
  hostStyle: string | null | undefined,
  dark: boolean,
) {
  const theme = dark ? "dark" : "light";
  return getScenarioHostFamily(hostStyle) === "chatgpt"
    ? cn(
        "scenario-host-composer rounded-[1.75rem]",
        CHATGPT_COMPOSER_CLASSES[theme],
      )
    : getScenarioHostFamily(hostStyle) === "claude"
      ? cn(
          "scenario-host-composer rounded-[1.35rem]",
          CLAUDE_COMPOSER_CLASSES[theme],
        )
      : "rounded-3xl border border-border/40 bg-muted/70";
}
