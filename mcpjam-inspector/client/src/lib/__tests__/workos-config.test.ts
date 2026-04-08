import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildElectronHostedAuthCallbackUrl,
  createElectronHostedAuthState,
  getWorkosDevMode,
  getWorkosRedirectUri,
} from "../workos-config";

describe("workos-config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.isElectron = false;
    window.history.replaceState({}, "", "/");
  });

  it("returns the app callback path in the browser", () => {
    expect(getWorkosRedirectUri()).toBe(`${window.location.origin}/callback`);
  });

  it("prefers the browser callback inside Electron", () => {
    window.isElectron = true;

    expect(getWorkosRedirectUri()).toBe(`${window.location.origin}/callback`);
  });

  it("marks hosted sign-in state for the Electron browser bridge", () => {
    expect(createElectronHostedAuthState({ returnTo: "/chat" })).toEqual(
      expect.objectContaining({
        electronHostedAuth: true,
        originalState: { returnTo: "/chat" },
      }),
    );
  });

  it("builds the Electron deep link from a hosted browser callback", () => {
    const state = createElectronHostedAuthState({ returnTo: "/chat" });
    const callbackUrl = new URL("http://localhost:5173/callback");
    callbackUrl.searchParams.set("code", "oauth-code");
    callbackUrl.searchParams.set("state", JSON.stringify(state));

    expect(buildElectronHostedAuthCallbackUrl(callbackUrl)).toBe(
      `mcpjam://oauth/callback?code=oauth-code&state=${encodeURIComponent(JSON.stringify(state))}`,
    );
  });

  it("does not show the hosted browser bridge after the callback returns to Electron", () => {
    const state = createElectronHostedAuthState();
    const callbackUrl = new URL("http://localhost:5173/callback");
    callbackUrl.searchParams.set("code", "oauth-code");
    callbackUrl.searchParams.set("state", JSON.stringify(state));
    window.isElectron = true;

    expect(buildElectronHostedAuthCallbackUrl(callbackUrl)).toBeNull();
  });

  it("respects explicit devMode environment overrides", () => {
    vi.stubEnv("VITE_WORKOS_DEV_MODE", "false");
    expect(getWorkosDevMode()).toBe(false);

    vi.stubEnv("VITE_WORKOS_DEV_MODE", "true");
    expect(getWorkosDevMode()).toBe(true);
  });
});
