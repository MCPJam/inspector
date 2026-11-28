import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OAuthDebugCallback, {
  buildElectronDebugCallbackUrl,
} from "../OAuthDebugCallback";
import {
  captureOAuthCallbackFromUrl,
  readOAuthCallbackParams,
  resetOAuthCallbackInboxForTests,
} from "@/lib/oauth-callback-inbox";
import {
  hashOAuthState,
  OAUTH_POPUP_MARKER_TTL_MS,
  oauthCallbackChannelName,
  readOAuthPopupMarker,
  writeOAuthPopupMarker,
} from "@/lib/oauth/popup-handoff-marker";

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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      window.name = "oauth_authorization_test";
      // Observe the delayed close without destroying the test's window.
      vi.spyOn(window, "close").mockImplementation(() => undefined);
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: { postMessage, closed: false },
      });
    });

    afterEach(() => {
      cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null,
      });
      vi.restoreAllMocks();
    });

    it("closes the popup after handing the code to its opener", () => {
      render(<OAuthDebugCallback />);
      expect(postMessage).toHaveBeenCalled();
      expect(window.close).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(window.close).toHaveBeenCalledTimes(1);
    });

    // Regression for the 2026-07-28 debugger crash: `URLSearchParams.get`
    // returns `null` for a missing param, and a null `iss` in the callback
    // message made the SDK machine treat a conformant AS that omits `iss`
    // (a SHOULD) as a present-but-mismatched issuer — crashing in
    // `quoteUntrusted` before the code could be redeemed. Absence must
    // travel as `undefined`.
    it("sends iss as undefined (never null) when the callback has no iss param", () => {
      render(<OAuthDebugCallback />);

      expect(postMessage).toHaveBeenCalled();
      const message = postMessage.mock.calls[0][0];
      expect(message).toMatchObject({
        type: "OAUTH_CALLBACK",
        code: "test-code",
        state: "test-state",
      });
      expect(message.iss).toBeUndefined();
      expect(message.iss).not.toBeNull();
    });

    it("sends the inbox's answer after main.tsx scrubbed the URL, then consumes it", () => {
      window.history.replaceState(
        {},
        "",
        "/oauth/callback/debug?code=inbox-code&state=inbox-state&iss=" +
          encodeURIComponent("https://auth.example.com"),
      );
      captureOAuthCallbackFromUrl();
      expect(window.location.href).not.toContain("inbox-code");

      render(<OAuthDebugCallback />);

      expect(postMessage).toHaveBeenCalled();
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
        screen.getByText("Authorization code sent successfully!"),
      ).toBeTruthy();
    });

    it("forwards a present iss verbatim", () => {
      window.history.replaceState(
        {},
        "",
        "/oauth/callback/debug?code=test-code&state=test-state&iss=" +
          encodeURIComponent("https://auth.example.com"),
      );

      render(<OAuthDebugCallback />);

      expect(postMessage).toHaveBeenCalled();
      expect(postMessage.mock.calls[0][0].iss).toBe(
        "https://auth.example.com",
      );
    });
  });

  // A COOP provider page clears `window.opener` and `window.name`, so the
  // callback can't tell a web popup from a desktop return by looking at them.
  // The opening tab's marker decides.
  describe("routing without an opener", () => {
    const originalLocation = window.location;
    const replace = vi.fn();
    const sent: Array<{ name: string; message: unknown }> = [];

    class FakeBroadcastChannel {
      constructor(readonly name: string) {}
      postMessage(message: unknown) {
        sent.push({ name: this.name, message });
      }
      close() {}
    }

    function arrive(search: string) {
      window.history.replaceState({}, "", `/oauth/callback/debug?${search}`);
      captureOAuthCallbackFromUrl();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...originalLocation, replace },
      });
      render(<OAuthDebugCallback />);
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      sent.length = 0;
      vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
      vi.spyOn(window, "close").mockImplementation(() => undefined);
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null,
      });
    });

    afterEach(() => {
      cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      replace.mockReset();
      localStorage.clear();
      window.isElectron = false;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    });

    it("sends the code on the flow's own channel when a marker matches", () => {
      writeOAuthPopupMarker("test-state", "conformance");

      arrive("code=test-code&state=test-state&iss=https%3A%2F%2Fauth.example.com");

      expect(sent).toEqual([
        {
          name: oauthCallbackChannelName(hashOAuthState("test-state")),
          message: expect.objectContaining({
            type: "OAUTH_CALLBACK",
            code: "test-code",
            state: "test-state",
            iss: "https://auth.example.com",
          }),
        },
      ]);
      expect(replace).not.toHaveBeenCalled();
      expect(readOAuthPopupMarker("test-state")).toBeNull();
      expect(readOAuthCallbackParams()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(window.close).toHaveBeenCalledTimes(1);
    });

    it("sends a provider error the same way, so a denied sign-in doesn't hang", () => {
      writeOAuthPopupMarker("test-state", "debugger");

      arrive(
        "error=access_denied&error_description=The+user+denied+access&state=test-state",
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].message).toEqual(
        expect.objectContaining({
          state: "test-state",
          error: "access_denied",
          errorDescription: "The user denied access",
          code: undefined,
        }),
      );
      expect(replace).not.toHaveBeenCalled();
    });

    it("hands off to the desktop app when no marker exists", () => {
      arrive("code=test-code&state=test-state");

      const deepLink =
        "mcpjam://oauth/callback?flow=debug&code=test-code&state=test-state";
      expect(replace).toHaveBeenCalledWith(deepLink);
      expect(sent).toEqual([]);
      expect(screen.getByRole("link", { name: "click here" })).toHaveProperty(
        "href",
        deepLink,
      );
    });

    it("hands off to the desktop app when the marker expired", () => {
      writeOAuthPopupMarker(
        "test-state",
        "debugger",
        Date.now() - OAUTH_POPUP_MARKER_TTL_MS - 1,
      );

      arrive("code=test-code&state=test-state");

      expect(replace).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
      expect(readOAuthPopupMarker("test-state")).toBeNull();
    });

    it("hands off to the desktop app when the marker is for another state", () => {
      writeOAuthPopupMarker("another-state", "debugger");

      arrive("code=test-code&state=test-state");

      expect(replace).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
      expect(readOAuthPopupMarker("another-state")).not.toBeNull();
    });

    it("leaves an Electron window's callback on screen, as before", () => {
      window.isElectron = true;

      arrive("code=test-code&state=test-state");

      expect(replace).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });
  });
});
