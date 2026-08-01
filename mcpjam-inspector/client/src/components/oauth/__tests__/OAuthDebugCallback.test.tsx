import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OAuthDebugCallback, {
  buildElectronDebugCallbackUrl,
} from "../OAuthDebugCallback";

describe("OAuthDebugCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.isElectron = false;
    window.name = "";
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
