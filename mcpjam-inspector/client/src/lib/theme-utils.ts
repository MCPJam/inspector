import { resolveThemeMode } from "./theme-mode";
import {
  THEME_MODE_KEY,
  THEME_PRESET_KEY,
} from "@/stores/preferences/preferences-store";
import {
  THEME_PRESET_OPTIONS,
  ThemeMode,
  ThemePreference,
  ThemePreset,
} from "@/types/preferences/theme";

// Utility to get the initial theme mode from localStorage or fallback to 'light'.
export function getInitialThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_MODE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system")
      return stored;
  } catch (error) {
    console.warn("Cannot access localStorage for theme mode:", error);
  }
  return "light";
}

export function getInitialThemeMode(): ThemeMode {
  return resolveThemeMode(getInitialThemePreference());
}

/**
 * The theme this tab renders: the root `dark` class that `updateThemeMode`
 * sets on every change. Storage can lag behind it when another tab switched
 * the theme, since the preferences store does not sync across tabs.
 */
export function getRenderedThemeMode(): ThemeMode {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function updateThemeMode(value: ThemeMode) {
  const doc = document.documentElement;
  doc.classList.add("disable-transitions");
  doc.classList.toggle("dark", value === "dark");
  requestAnimationFrame(() => {
    doc.classList.remove("disable-transitions");
  });
}

// Utility to get the initial theme preset from localStorage or fallback to 'default'.
export function getInitialThemePreset(): ThemePreset {
  try {
    const stored = localStorage.getItem(THEME_PRESET_KEY);
    const validPresets = THEME_PRESET_OPTIONS.map((p) => p.value);
    if (stored && validPresets.includes(stored as ThemePreset)) {
      return stored as ThemePreset;
    }
  } catch (error) {
    console.warn("Cannot access localStorage for theme preset:", error);
  }
  return "default";
}

export function updateThemePreset(value: ThemePreset) {
  document.documentElement.setAttribute("data-theme-preset", value);
}
