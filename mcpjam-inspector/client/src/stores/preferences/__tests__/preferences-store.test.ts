import { beforeEach, describe, expect, it } from "vitest";
import {
  createPreferencesStore,
  HOST_STYLE_KEY,
  THEME_MODE_KEY,
  THEME_PRESET_KEY,
} from "../preferences-store";

describe("preferences-store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes host style from the shared persisted key and persists updates", () => {
    localStorage.setItem(HOST_STYLE_KEY, "chatgpt");

    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    expect(store.getState().hostStyle).toBe("chatgpt");

    store.getState().setHostStyle("claude");

    expect(store.getState().hostStyle).toBe("claude");
    expect(localStorage.getItem(HOST_STYLE_KEY)).toBe("claude");
  });

  it("falls back to claude when the persisted host style is invalid", () => {
    localStorage.setItem(HOST_STYLE_KEY, "invalid-host-style");

    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    expect(store.getState().hostStyle).toBe("claude");
  });

  it("continues persisting theme preferences alongside host style", () => {
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    store.getState().setThemeMode("dark");
    store.getState().setThemePreset("soft-pop");

    expect(localStorage.getItem(THEME_MODE_KEY)).toBe("dark");
    expect(localStorage.getItem(THEME_PRESET_KEY)).toBe("soft-pop");
  });
});
