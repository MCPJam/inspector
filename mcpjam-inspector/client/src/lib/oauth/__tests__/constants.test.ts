import { afterEach, describe, expect, it } from "vitest";
import {
  MCPJAM_HOSTED_APP_ORIGIN,
  getRedirectUri,
  resolveBrowserOAuthRedirectOrigin,
  supportsMcpJamCimdRedirect,
} from "../constants";

describe("resolveBrowserOAuthRedirectOrigin", () => {
  it("keeps localhost origins for local development", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(new URL("http://localhost:5173/#test"))
    ).toBe("http://localhost:5173");
  });

  it("keeps 127.0.0.1 origins for local development", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(new URL("http://127.0.0.1:5173/#test"))
    ).toBe("http://127.0.0.1:5173");
  });

  it("keeps the current origin on the hosted app domain", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://app.mcpjam.com/#servers")
      )
    ).toBe("https://app.mcpjam.com");
  });

  it("keeps the current origin on hosted subdomains like staging", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://staging.mcpjam.com/#servers")
      )
    ).toBe("https://staging.mcpjam.com");
  });

  it.each([
    "https://pr-5479.mcpjam.dev/home",
    "https://pr-be-1693.mcpjam.dev/home",
    "https://mcp-inspector-pr-5479.up.railway.app/home",
    "https://mcp-inspector-pr-be-1693.up.railway.app/home",
  ])("keeps the callback on supported Inspector preview %s", (url) => {
    expect(resolveBrowserOAuthRedirectOrigin(new URL(url))).toBe(
      new URL(url).origin
    );
  });

  it("does not treat an unrelated Railway app as an Inspector preview", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://unrelated-app.up.railway.app/home")
      )
    ).toBe(MCPJAM_HOSTED_APP_ORIGIN);
  });

  it("falls back to the hosted app origin from the marketing site", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://www.mcpjam.com/oauth/callback")
      )
    ).toBe(MCPJAM_HOSTED_APP_ORIGIN);
  });

  /**
   * score.mcpjam.com runs real authorizations, and every piece of state that
   * carries one — the pending marker, the resume record, the guest cookie — is
   * per-origin. Sending its callback to the app would land the visitor on a
   * host that can read none of them, so the flow would dead-end and the scan
   * would be lost. It has to keep its own callback.
   */
  it("keeps the current origin on the score domain", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://score.mcpjam.com/embed/score")
      )
    ).toBe("https://score.mcpjam.com");
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://www.score.mcpjam.com/embed/score")
      )
    ).toBe("https://www.score.mcpjam.com");
  });
});

describe("supportsMcpJamCimdRedirect", () => {
  it.each([
    "pr-5479.mcpjam.dev",
    "pr-be-1693.mcpjam.dev",
    "mcp-inspector-pr-5479.up.railway.app",
    "mcp-inspector-pr-be-1693.up.railway.app",
  ])("requires DCR on ephemeral preview %s", (hostname) => {
    expect(supportsMcpJamCimdRedirect({ hostname })).toBe(false);
  });

  it("permits CIMD on stable origins", () => {
    expect(supportsMcpJamCimdRedirect({ hostname: "app.mcpjam.com" })).toBe(
      true
    );
    expect(supportsMcpJamCimdRedirect({ hostname: "localhost" })).toBe(true);
  });
});

describe("getRedirectUri", () => {
  afterEach(() => {
    delete window.isElectron;
  });

  it("uses the browser callback route when the Electron preload flag is present", () => {
    window.isElectron = true;

    expect(getRedirectUri()).toBe(`${window.location.origin}/oauth/callback`);
  });

  it("uses the browser callback route outside Electron", () => {
    expect(getRedirectUri()).toBe(`${window.location.origin}/oauth/callback`);
  });
});
