import {
  THEME_PRESET_OPTIONS,
  ThemeMode,
  ThemePreset,
} from "@/types/preferences/theme";

// Utility to get the initial theme mode from localStorage or fallback to 'light'.
export function getInitialThemeMode(): ThemeMode {
  const stored = localStorage.getItem("themeMode");
  if (stored === "dark" || stored === "light") return stored;
  return "light";
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
  const stored = localStorage.getItem("themePreset");
  const validPresets = THEME_PRESET_OPTIONS.map((p) => p.value);
  if (stored && validPresets.includes(stored as ThemePreset)) {
    return stored as ThemePreset;
  }
  return "default";
}

export function updateThemePreset(value: ThemePreset) {
  document.documentElement.setAttribute("data-theme-preset", value);
}
