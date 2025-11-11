import { createStore } from "zustand/vanilla";

import type { ThemeMode, ThemePreset } from "@/types/preferences/theme";

export type PreferencesState = {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  setThemeMode: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
};

const THEME_MODE_KEY = "themeMode";
const THEME_PRESET_KEY = "themePreset";

export const createPreferencesStore = (init?: Partial<PreferencesState>) =>
  createStore<PreferencesState>()((set) => ({
    themeMode: init?.themeMode ?? "light",
    themePreset: init?.themePreset ?? "default",
    setThemeMode: (mode) => {
      localStorage.setItem(THEME_MODE_KEY, mode);
      set({ themeMode: mode });
    },
    setThemePreset: (preset) => {
      localStorage.setItem(THEME_PRESET_KEY, preset);
      set({ themePreset: preset });
    },
  }));
