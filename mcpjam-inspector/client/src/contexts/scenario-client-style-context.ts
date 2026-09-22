import { createContext, useContext } from "react";
import type { ScenarioHostStyle } from "@/lib/scenario-client-style";
import type { ChatUiOverride } from "@/lib/client-styles";

const ScenarioHostStyleContext = createContext<ScenarioHostStyle | null>(null);
const ScenarioHostThemeContext = createContext<"light" | "dark" | null>(null);
/**
 * Persisted chat-UI override for the active scenario. Sister context to
 * {@link ScenarioHostStyleProvider}: hostStyle picks the preset, this
 * carries the user's per-host customizations on top of it (logo, palette,
 * indicator, etc.). `undefined` means "no override; preset wins" — same
 * semantics as `HostConfigInputV2.chatUiOverride`.
 */
const ScenarioChatUiOverrideContext = createContext<ChatUiOverride | undefined>(
  undefined,
);

export const ScenarioHostStyleProvider = ScenarioHostStyleContext.Provider;
export const ScenarioHostThemeProvider = ScenarioHostThemeContext.Provider;
export const ScenarioChatUiOverrideProvider =
  ScenarioChatUiOverrideContext.Provider;

export function useScenarioHostStyle(): ScenarioHostStyle | null {
  return useContext(ScenarioHostStyleContext);
}

export function useScenarioHostTheme(): "light" | "dark" | null {
  return useContext(ScenarioHostThemeContext);
}

export function useScenarioChatUiOverride(): ChatUiOverride | undefined {
  return useContext(ScenarioChatUiOverrideContext);
}
