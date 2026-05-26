import { describe, expect, it } from "vitest";
import {
  buildProtocolOAuthCallbackUrl,
  buildRendererCallbackUrl,
  ELECTRON_HOSTED_AUTH_STATE_KEY,
} from "../../src/oauth-callback-routing.js";

const rendererBaseUrl = "http://localhost:5173";

describe("Electron OAuth callback routing", () => {
  it("routes tagged hosted auth callbacks into the desktop protocol", () => {
    const state = JSON.stringify({
      [ELECTRON_HOSTED_AUTH_STATE_KEY]: true,
      originalState: "workos-state",
    });
    const callbackUrl = new URL("/callback", rendererBaseUrl);
    callbackUrl.searchParams.set("code", "hosted-code");
    callbackUrl.searchParams.set("state", state);

    expect(
      buildProtocolOAuthCallbackUrl(callbackUrl.toString(), rendererBaseUrl)
    ).toBe(
      `mcpjam://oauth/callback?code=hosted-code&state=${encodeURIComponent(
        state
      )}`
    );
  });

  it("routes tagged MCP callbacks into the desktop protocol", () => {
    const callbackUrl = new URL("/oauth/callback", rendererBaseUrl);
    callbackUrl.searchParams.set("code", "mcp-code");
    callbackUrl.searchParams.set("state", "electron_mcp:mcp-state");

    expect(
      buildProtocolOAuthCallbackUrl(callbackUrl.toString(), rendererBaseUrl)
    ).toBe(
      "mcpjam://oauth/callback?flow=mcp&code=mcp-code&state=electron_mcp%3Amcp-state"
    );
  });

  it("routes OAuth debugger callbacks into the desktop protocol", () => {
    const callbackUrl = new URL("/oauth/callback/debug", rendererBaseUrl);
    callbackUrl.searchParams.set("code", "debug-code");
    callbackUrl.searchParams.set("state", "debug-state");

    expect(
      buildProtocolOAuthCallbackUrl(callbackUrl.toString(), rendererBaseUrl)
    ).toBe(
      "mcpjam://oauth/callback?flow=debug&code=debug-code&state=debug-state"
    );
  });

  it("rejects untagged hosted auth callbacks", () => {
    const callbackUrl = new URL("/callback", rendererBaseUrl);
    callbackUrl.searchParams.set("code", "hosted-code");
    callbackUrl.searchParams.set("state", "plain-state");

    expect(
      buildProtocolOAuthCallbackUrl(callbackUrl.toString(), rendererBaseUrl)
    ).toBeNull();
  });

  it("rejects external callback-shaped URLs", () => {
    const callbackUrl = new URL("/oauth/callback", "https://evil.example");
    callbackUrl.searchParams.set("code", "mcp-code");
    callbackUrl.searchParams.set("state", "electron_mcp:mcp-state");

    expect(
      buildProtocolOAuthCallbackUrl(callbackUrl.toString(), rendererBaseUrl)
    ).toBeNull();
  });

  it("maps desktop protocol callbacks back to renderer routes", () => {
    const protocolUrl = new URL(
      "mcpjam://oauth/callback?flow=mcp&code=mcp-code&state=electron_mcp%3Amcp-state"
    );

    expect(
      buildRendererCallbackUrl(protocolUrl, rendererBaseUrl)?.toString()
    ).toBe(
      "http://localhost:5173/oauth/callback?code=mcp-code&state=electron_mcp%3Amcp-state"
    );
  });
});
