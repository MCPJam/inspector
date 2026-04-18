import { createStore } from "zustand/vanilla";

import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import type { ThemeMode, ThemePreset } from "@/types/preferences/theme";

export type PreferencesState = {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  hostStyle: ChatboxHostStyle;
  setThemeMode: (mode: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
  setHostStyle: (hostStyle: ChatboxHostStyle) => void;
};

export const THEME_MODE_KEY = "themeMode";
export const THEME_PRESET_KEY = "themePreset";
export const HOST_STYLE_KEY = "mcpjam-ui-playground-host-style";

function getStoredHostStyle(): ChatboxHostStyle {
  if (typeof window === "undefined") return "claude";

  try {
    const stored = localStorage.getItem(HOST_STYLE_KEY);
    if (stored === "claude" || stored === "chatgpt") {
      return stored;
    }
  } catch (error) {
    console.warn("Failed to read persisted host style:", error);
  }

  return "claude";
}

export const createPreferencesStore = (init?: Partial<PreferencesState>) =>
  createStore<PreferencesState>()((set) => ({
    themeMode: init?.themeMode ?? "light",
    themePreset: init?.themePreset ?? "default",
    hostStyle: init?.hostStyle ?? getStoredHostStyle(),
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
    setHostStyle: (hostStyle) => {
      try {
        localStorage.setItem(HOST_STYLE_KEY, hostStyle);
      } catch (error) {
        console.warn("Failed to persist host style:", error);
      }
      set({ hostStyle });
    },
  }));
