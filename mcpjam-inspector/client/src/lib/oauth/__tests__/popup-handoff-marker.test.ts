import { afterEach, describe, expect, it } from "vitest";
import {
  buildOAuthCallbackMessage,
  deleteOAuthPopupMarker,
  hashOAuthState,
  OAUTH_POPUP_MARKER_TTL_MS,
  readOAuthPopupMarker,
  resolveOAuthCallbackRoute,
  writeOAuthPopupMarker,
} from "../popup-handoff-marker";

function storedKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) =>
    String(localStorage.key(index)),
  );
}

describe("OAuth popup marker", () => {
  afterEach(() => localStorage.clear());

  it("stores only the flow and its times, under a hash of state", () => {
    writeOAuthPopupMarker("secret-state", "debugger", 1_000);

    const keys = storedKeys();
    expect(keys).toEqual([`mcpjam:oauth-popup:${hashOAuthState("secret-state")}`]);
    expect(JSON.parse(localStorage.getItem(keys[0])!)).toEqual({
      flow: "debugger",
      createdAt: 1_000,
      expiresAt: 1_000 + OAUTH_POPUP_MARKER_TTL_MS,
    });
    expect(localStorage.getItem(keys[0])).not.toContain("secret-state");
  });

  it("clears expired markers when it writes a new one", () => {
    writeOAuthPopupMarker("old", "conformance", 0);
    writeOAuthPopupMarker("new", "conformance", OAUTH_POPUP_MARKER_TTL_MS + 1);

    expect(storedKeys()).toEqual([
      `mcpjam:oauth-popup:${hashOAuthState("new")}`,
    ]);
  });

  it("reads a live marker and drops an expired or deleted one", () => {
    writeOAuthPopupMarker("s", "debugger", 0);
    expect(readOAuthPopupMarker("s", OAUTH_POPUP_MARKER_TTL_MS - 1)).toMatchObject({
      flow: "debugger",
    });
    expect(readOAuthPopupMarker("s", OAUTH_POPUP_MARKER_TTL_MS)).toBeNull();
    expect(localStorage.length).toBe(0);

    writeOAuthPopupMarker("s", "debugger");
    deleteOAuthPopupMarker("s");
    expect(readOAuthPopupMarker("s")).toBeNull();
  });

  it("routes to the opener first, then a marker, then the desktop app", () => {
    writeOAuthPopupMarker("s", "conformance");

    expect(resolveOAuthCallbackRoute(true, "s")).toBe("opener");
    expect(resolveOAuthCallbackRoute(false, "s")).toBe("channel");
    expect(resolveOAuthCallbackRoute(false, "other")).toBe("desktop");
    expect(resolveOAuthCallbackRoute(false, null)).toBe("desktop");
  });

  it("builds a message from a code or a provider error, keeping iss", () => {
    expect(
      buildOAuthCallbackMessage(new URLSearchParams("code=c&state=s&iss=https://as")),
    ).toEqual({
      type: "OAUTH_CALLBACK",
      code: "c",
      state: "s",
      iss: "https://as",
      error: undefined,
      errorDescription: undefined,
    });
    expect(
      buildOAuthCallbackMessage(
        new URLSearchParams("error=access_denied&error_description=No&state=s"),
      ),
    ).toMatchObject({ error: "access_denied", errorDescription: "No", code: undefined });
    expect(buildOAuthCallbackMessage(new URLSearchParams("state=s"))).toBeNull();
  });
});
