import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OAuthDebugCallback, {
  buildElectronDebugCallbackUrl,
} from "../OAuthDebugCallback";
import {
  captureOAuthCallbackFromUrl,
  readOAuthCallbackParams,
  resetOAuthCallbackInboxForTests,
} from "@/lib/oauth-callback-inbox";

describe("OAuthDebugCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.isElectron = false;
    window.name = "";
    resetOAuthCallbackInboxForTests();
    window.history.replaceState(
      {},
      "",
      "/oauth/callback/debug?code=test-code&state=test-state",
    );
  });

  it("builds the Electron deep-link callback URL for browser returns", () => {
    expect(buildElectronDebugCallbackUrl()).toBe(
      "mcpjam://oauth/callback?flow=debug&code=test-code&state=test-state",
    );
  });

  it("builds the Electron deep link from the inbox once the URL is scrubbed", () => {
    captureOAuthCallbackFromUrl();
    expect(window.location.search).toBe("?oauth_pending=1");
    expect(buildElectronDebugCallbackUrl()).toBe(
      "mcpjam://oauth/callback?flow=debug&code=test-code&state=test-state",
    );
  });

  describe("popup callback message", () => {
    const postMessage = vi.fn();

    beforeEach(() => {
      window.name = "oauth_authorization_test";
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: { postMessage, closed: false },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null,
      });
      vi.restoreAllMocks();
    });

    // Regression for the 2026-07-28 debugger crash: `URLSearchParams.get`
    // returns `null` for a missing param, and a null `iss` in the callback
    // message made the SDK machine treat a conformant AS that omits `iss`
    // (a SHOULD) as a present-but-mismatched issuer — crashing in
    // `quoteUntrusted` before the code could be redeemed. Absence must
    // travel as `undefined`.
    it("sends iss as undefined (never null) when the callback has no iss param", async () => {
      render(<OAuthDebugCallback />);

      await waitFor(() => expect(postMessage).toHaveBeenCalled());
      const message = postMessage.mock.calls[0][0];
      expect(message).toMatchObject({
        type: "OAUTH_CALLBACK",
        code: "test-code",
        state: "test-state",
      });
      expect(message.iss).toBeUndefined();
      expect(message.iss).not.toBeNull();
    });

    it("sends the inbox's answer after main.tsx scrubbed the URL, then consumes it", async () => {
      window.history.replaceState(
        {},
        "",
        "/oauth/callback/debug?code=inbox-code&state=inbox-state&iss=" +
          encodeURIComponent("https://auth.example.com"),
      );
      captureOAuthCallbackFromUrl();
      expect(window.location.href).not.toContain("inbox-code");

      render(<OAuthDebugCallback />);

      await waitFor(() => expect(postMessage).toHaveBeenCalled());
      expect(postMessage.mock.calls[0][0]).toMatchObject({
        type: "OAUTH_CALLBACK",
        code: "inbox-code",
        state: "inbox-state",
        iss: "https://auth.example.com",
      });
      // Handed to the opener; the code was never written to storage.
      expect(readOAuthCallbackParams()).toBeNull();
      expect(
        Array.from({ length: sessionStorage.length }, (_, i) =>
        sessionStorage.getItem(sessionStorage.key(i) ?? ""),
      ).join("\n"),
      ).not.toContain("inbox-code");
      // And the card still says it worked, rather than re-reading an empty
      // inbox as "Missing code or error in response".
      expect(
        await screen.findByText("Authorization code sent successfully!"),
      ).toBeTruthy();
    });

    it("forwards a present iss verbatim", async () => {
      window.history.replaceState(
        {},
        "",
        "/oauth/callback/debug?code=test-code&state=test-state&iss=" +
          encodeURIComponent("https://auth.example.com"),
      );

      render(<OAuthDebugCallback />);

      await waitFor(() => expect(postMessage).toHaveBeenCalled());
      expect(postMessage.mock.calls[0][0].iss).toBe(
        "https://auth.example.com",
      );
    });
  });
});
