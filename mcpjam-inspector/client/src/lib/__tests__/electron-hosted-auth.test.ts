import { describe, expect, it } from "vitest";
import {
  buildElectronHostedAuthCallbackUrl,
  createElectronHostedAuthState,
  ELECTRON_HOSTED_AUTH_STATE_KEY,
  isElectronHostedAuthCallback,
  parseElectronHostedAuthState,
  resolveWorkosRedirectUri,
} from "../electron-hosted-auth";

describe("electron hosted auth helpers", () => {
  it("tags object state for Electron hosted auth", () => {
    expect(createElectronHostedAuthState({ foo: "bar" })).toEqual({
      foo: "bar",
      [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
    });
  });

  it("parses tagged Electron hosted auth state", () => {
    expect(
      parseElectronHostedAuthState(
        JSON.stringify({
          [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
          foo: "bar",
        })
      )
    ).toEqual({
      [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
      foo: "bar",
    });
  });

  it("builds a desktop callback url for browser Electron callbacks", () => {
    const state = JSON.stringify({
      [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
    });
    const location = {
      pathname: "/callback",
      search: `?code=test-code&state=${encodeURIComponent(state)}`,
    } as Pick<Location, "pathname" | "search">;

    expect(isElectronHostedAuthCallback(location)).toBe(true);
    expect(buildElectronHostedAuthCallbackUrl(location)).toBe(
      `mcpjam://oauth/callback?code=test-code&state=${encodeURIComponent(
        state
      )}`
    );
  });

  it("uses the browser callback path for Electron launches", () => {
    expect(
      resolveWorkosRedirectUri({
        envRedirect: "mcpjam://oauth/callback",
        isElectron: true,
        location: {
          origin: "http://localhost:5173",
          pathname: "/",
          protocol: "http:",
          search: "",
        } as Pick<Location, "origin" | "pathname" | "protocol" | "search">,
      })
    ).toBe("http://localhost:5173/callback");
  });

  it("uses the configured redirect for non-http browser locations", () => {
    expect(
      resolveWorkosRedirectUri({
        envRedirect: "https://app.mcpjam.com/callback",
        isElectron: false,
        location: {
          origin: "file://",
          pathname: "/index.html",
          protocol: "file:",
          search: "",
        } as Pick<Location, "origin" | "pathname" | "protocol" | "search">,
      })
    ).toBe("https://app.mcpjam.com/callback");
  });

  it("rejects non-http browser locations without a configured redirect", () => {
    expect(() =>
      resolveWorkosRedirectUri({
        isElectron: false,
        location: {
          origin: "file://",
          pathname: "/index.html",
          protocol: "file:",
          search: "",
        } as Pick<Location, "origin" | "pathname" | "protocol" | "search">,
      })
    ).toThrow("WorkOS redirect URI requires an HTTP(S) browser origin.");
  });
});
