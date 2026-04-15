import { describe, expect, it } from "vitest";
import {
  MCPJAM_HOSTED_APP_ORIGIN,
  resolveBrowserOAuthRedirectOrigin,
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

  it("falls back to the hosted app origin from the marketing site", () => {
    expect(
      resolveBrowserOAuthRedirectOrigin(
        new URL("https://www.mcpjam.com/oauth/callback")
      )
    ).toBe(MCPJAM_HOSTED_APP_ORIGIN);
  });
});
