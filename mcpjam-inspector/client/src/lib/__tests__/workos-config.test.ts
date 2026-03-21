import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkosDevMode, getWorkosRedirectUri } from "../workos-config";

describe("workos-config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.isElectron = false;
    window.history.replaceState({}, "", "/");
  });

  it("returns the app callback path in the browser", () => {
    expect(getWorkosRedirectUri()).toBe(`${window.location.origin}/callback`);
  });

  it("prefers the Electron deep link callback inside Electron", () => {
    window.isElectron = true;

    expect(getWorkosRedirectUri()).toBe("mcpjam://oauth/callback");
  });

  it("allows an explicit redirect URI override in Electron", () => {
    vi.stubEnv(
      "VITE_WORKOS_REDIRECT_URI",
      "https://override.example.com/callback",
    );
    window.isElectron = true;

    expect(getWorkosRedirectUri()).toBe(
      "https://override.example.com/callback",
    );
  });

  it("respects explicit devMode environment overrides", () => {
    vi.stubEnv("VITE_WORKOS_DEV_MODE", "false");
    expect(getWorkosDevMode()).toBe(false);

    vi.stubEnv("VITE_WORKOS_DEV_MODE", "true");
    expect(getWorkosDevMode()).toBe(true);
  });
});
