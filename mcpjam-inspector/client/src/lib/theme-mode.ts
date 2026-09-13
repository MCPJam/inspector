import type { ThemeMode, ThemePreference } from "@/types/preferences/theme";

export function resolveThemeMode(preference: ThemePreference): ThemeMode {
  if (preference !== "system") return preference;
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
