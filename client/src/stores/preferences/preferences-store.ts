import { createStore } from "zustand/vanilla";

import type { ThemeMode, ThemePreset } from "@/types/preferences/theme";

export type PreferencesState = {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  setThemeMode: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
};

export const THEME_MODE_KEY = "themeMode";
export const THEME_PRESET_KEY = "themePreset";

export const createPreferencesStore = (init?: Partial<PreferencesState>) =>
  createStore<PreferencesState>()((set) => ({
    themeMode: init?.themeMode ?? "light",
    themePreset: init?.themePreset ?? "default",
    setThemeMode: (mode) => {
      try {
        localStorage.setItem(THEME_MODE_KEY, mode);
      } catch (error) {
        console.warn("Failed to persist theme mode:", error);
      }
      set({ themeMode: mode });
    },
    setThemePreset: (preset) => {
      try {
        localStorage.setItem(THEME_PRESET_KEY, preset);
      } catch (error) {
        console.warn("Failed to persist theme preset:", error);
      }
      set({ themePreset: preset });
    },
  }));
