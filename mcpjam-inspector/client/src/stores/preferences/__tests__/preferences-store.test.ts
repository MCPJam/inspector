import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_CONNECT_SERVERS_KEY,
  createPreferencesStore,
  HOST_CAPABILITIES_OVERRIDE_KEY,
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

  it("preserves extensible persisted host style ids", () => {
    localStorage.setItem(HOST_STYLE_KEY, "codex");

    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    expect(store.getState().hostStyle).toBe("codex");
  });

  it("falls back to the default host style (mcpjam) when the persisted host style is blank", () => {
    localStorage.setItem(HOST_STYLE_KEY, "   ");

    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    expect(store.getState().hostStyle).toBe("mcpjam");
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

  it("defaults hostCapabilitiesOverride to undefined (use host style preset)", () => {
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });
    expect(store.getState().hostCapabilitiesOverride).toBeUndefined();
  });

  it("persists hostCapabilitiesOverride to localStorage as JSON", () => {
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    store.getState().setHostCapabilitiesOverride({ openLinks: {} });

    expect(store.getState().hostCapabilitiesOverride).toEqual({
      openLinks: {},
    });
    expect(
      JSON.parse(localStorage.getItem(HOST_CAPABILITIES_OVERRIDE_KEY) ?? "{}"),
    ).toEqual({ openLinks: {} });
  });

  it("hydrates hostCapabilitiesOverride from localStorage on init", () => {
    localStorage.setItem(
      HOST_CAPABILITIES_OVERRIDE_KEY,
      JSON.stringify({ logging: {} }),
    );
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });
    expect(store.getState().hostCapabilitiesOverride).toEqual({
      logging: {},
    });
  });

  it("clearing hostCapabilitiesOverride to undefined removes the localStorage entry", () => {
    // Initial state: an override is persisted. The "Reset to preset" action
    // sets the field to undefined; the localStorage entry must be removed
    // (not left as "null") so the next reload also returns undefined and
    // the user lands back on the host style preset.
    localStorage.setItem(
      HOST_CAPABILITIES_OVERRIDE_KEY,
      JSON.stringify({ openLinks: {} }),
    );
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });
    expect(store.getState().hostCapabilitiesOverride).toEqual({
      openLinks: {},
    });

    store.getState().setHostCapabilitiesOverride(undefined);

    expect(store.getState().hostCapabilitiesOverride).toBeUndefined();
    expect(localStorage.getItem(HOST_CAPABILITIES_OVERRIDE_KEY)).toBeNull();
  });

  it("distinguishes saved empty {} override from undefined (preset)", () => {
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });

    // {} means "advertise nothing" — must NOT collapse to undefined.
    store.getState().setHostCapabilitiesOverride({});
    expect(store.getState().hostCapabilitiesOverride).toEqual({});
    expect(localStorage.getItem(HOST_CAPABILITIES_OVERRIDE_KEY)).toBe("{}");
  });

  it("silently ignores a corrupt persisted override (falls back to preset)", () => {
    localStorage.setItem(HOST_CAPABILITIES_OVERRIDE_KEY, "{not-valid-json");
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });
    expect(store.getState().hostCapabilitiesOverride).toBeUndefined();
  });

  it("defaults autoConnectServersEnabled to true and persists toggles", () => {
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });
    expect(store.getState().autoConnectServersEnabled).toBe(true);

    store.getState().setAutoConnectServersEnabled(false);
    expect(store.getState().autoConnectServersEnabled).toBe(false);
    expect(localStorage.getItem(AUTO_CONNECT_SERVERS_KEY)).toBe("false");

    store.getState().setAutoConnectServersEnabled(true);
    expect(localStorage.getItem(AUTO_CONNECT_SERVERS_KEY)).toBe("true");
  });

  it("hydrates autoConnectServersEnabled=false from localStorage", () => {
    localStorage.setItem(AUTO_CONNECT_SERVERS_KEY, "false");
    const store = createPreferencesStore({
      themeMode: "light",
      themePreset: "default",
    });
    expect(store.getState().autoConnectServersEnabled).toBe(false);
  });
});
