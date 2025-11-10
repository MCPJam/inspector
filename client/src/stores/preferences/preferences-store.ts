import { createStore } from "zustand/vanilla";

import type { ThemeMode, ThemePreset } from "@/types/preferences/theme";

const STORAGE_KEY = "mcp-inspector-preferences";

// Load preferences from localStorage
function loadPreferences(): Partial<PreferencesState> {
  if (typeof window === "undefined") return {};

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.warn("Failed to load preferences from localStorage:", error);
  }
  return {};
}

// Save preferences to localStorage
function savePreferences(state: PreferencesState) {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        themeMode: state.themeMode,
        themePreset: state.themePreset,
      }),
    );
  } catch (error) {
    console.warn("Failed to save preferences to localStorage:", error);
  }
}

export type PreferencesState = {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  setThemeMode: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
};

export const createPreferencesStore = (init?: Partial<PreferencesState>) => {
  // Load saved preferences and merge with init values
  const savedPreferences = loadPreferences();
  const initialState = {
    themeMode: savedPreferences.themeMode ?? init?.themeMode ?? "light",
    themePreset: savedPreferences.themePreset ?? init?.themePreset ?? "default",
  };

  return createStore<PreferencesState>()((set) => ({
    ...initialState,
    setThemeMode: (mode) =>
      set((state) => {
        const newState = { ...state, themeMode: mode };
        savePreferences(newState);
        return { themeMode: mode };
      }),
    setThemePreset: (preset) =>
      set((state) => {
        const newState = { ...state, themePreset: preset };
        savePreferences(newState);
        return { themePreset: preset };
      }),
  }));
};
