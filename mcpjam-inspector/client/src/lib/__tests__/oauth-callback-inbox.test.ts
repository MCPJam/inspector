import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  containsCredential,
  isReplayBlockedLocation,
} from "@/shared/credential-urls";
import {
  captureOAuthCallbackFromUrl,
  consumeOAuthCallbackParams,
  depositOAuthCallbackParams,
  hasOAuthPendingMarker,
  hasPendingOAuthCallback,
  isOAuthCallbackPath,
  OAUTH_CALLBACK_EXPIRED_DESCRIPTION,
  OAUTH_CALLBACK_EXPIRED_ERROR,
  readOAuthCallbackParams,
  resetOAuthCallbackInboxForTests,
} from "../oauth-callback-inbox";

// ═══════════════════════════════════════════════════════════════════════════
// THE OAUTH CALLBACK INBOX
// ═══════════════════════════════════════════════════════════════════════════
//
// `main.tsx` moves an MCP OAuth callback's answer out of the address bar
// before telemetry starts. What these pin:
//
//   1. The code leaves the URL — query AND any fragment that could carry it —
//      and only `?oauth_pending=1` is left behind, with `history.state` intact.
//   2. Only MCP callback routes are touched: WorkOS' `/callback` belongs to
//      authkit-js, and the GitHub install callback has its own page.
//   3. Every reader still gets the whole answer, as often as it asks, for as
//      long as the callback route is showing.
//   4. The code is held in memory only — never written to storage — so a
//      reload of the pending page answers with an explicit error, never
//      silence and never a restored credential.

/** A fresh module instance: what a page reload gives `main.tsx`. */
async function reloadInboxModule() {
  vi.resetModules();
  return import("../oauth-callback-inbox");
}

/** Everything in both storages, to prove a code never lands in either. */
function storageText(): string {
  const read = (storage: Storage) =>
    Array.from({ length: storage.length }, (_, i) =>
      storage.getItem(storage.key(i) ?? ""),
    ).join("\n");
  return `${read(sessionStorage)}\n${read(localStorage)}`;
}

beforeEach(() => {
  resetOAuthCallbackInboxForTests();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capturing the callback", () => {
  it("moves every parameter into the inbox and leaves only the marker", () => {
    window.history.replaceState(
      { idx: 3 },
      "",
      "/oauth/callback?code=one-time-code&state=s1&iss=https%3A%2F%2Fauth.example.com&session_state=xyz",
    );

    expect(captureOAuthCallbackFromUrl()).toBe(true);

    expect(window.location.pathname).toBe("/oauth/callback");
    expect(window.location.search).toBe("?oauth_pending=1");
    expect(window.location.href).not.toContain("one-time-code");
    expect(window.history.state).toEqual({ idx: 3 });

    const params = readOAuthCallbackParams();
    expect(params?.get("code")).toBe("one-time-code");
    expect(params?.get("state")).toBe("s1");
    expect(params?.get("iss")).toBe("https://auth.example.com");
    // Not a fixed list: whatever the authorization server sent.
    expect(params?.get("session_state")).toBe("xyz");
    expect(params?.has("oauth_pending")).toBe(false);
  });

  it("captures an error answer with its description and URI", () => {
    window.history.replaceState(
      null,
      "",
      "/oauth/callback?error=access_denied&error_description=User%20said%20no&error_uri=https%3A%2F%2Fdocs&state=s1",
    );
    captureOAuthCallbackFromUrl();

    const params = readOAuthCallbackParams();
    expect(params?.get("error")).toBe("access_denied");
    expect(params?.get("error_description")).toBe("User said no");
    expect(params?.get("error_uri")).toBe("https://docs");
    expect(window.location.search).toBe("?oauth_pending=1");
  });

  it("captures the debugger's callback under /oauth/callback/", () => {
    window.history.replaceState(
      null,
      "",
      "/oauth/callback/debug?code=dbg&state=s",
    );
    expect(captureOAuthCallbackFromUrl()).toBe(true);
    expect(window.location.pathname).toBe("/oauth/callback/debug");
    expect(window.location.search).toBe("?oauth_pending=1");
    expect(readOAuthCallbackParams()?.get("code")).toBe("dbg");
  });

  it.each([
    // authkit-js consumes the WorkOS code itself; it must still find it.
    "/callback?code=workos&state=w",
    "/settings/integrations/github/callback?code=gh&state=g",
    "/oauth/callbacks?code=x",
    "/servers?code=x",
  ])("leaves %s alone", (url) => {
    window.history.replaceState(null, "", url);
    expect(captureOAuthCallbackFromUrl()).toBe(false);
    expect(`${window.location.pathname}${window.location.search}`).toBe(url);
    expect(readOAuthCallbackParams()).toBeNull();
  });

  it("does nothing on a callback path with no query", () => {
    window.history.replaceState(null, "", "/oauth/callback");
    expect(captureOAuthCallbackFromUrl()).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("keeps a plain anchor fragment", () => {
    window.history.replaceState(null, "", "/oauth/callback?code=c#tools");
    captureOAuthCallbackFromUrl();
    expect(window.location.hash).toBe("#tools");
  });

  it.each([
    "#code=fragment-code&state=s",
    "#access_token=abc",
    "#id_token=abc",
    "#tab=tools&token=abc",
    // Opaque: could be a bare token, so it does not get the benefit of doubt.
    "#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
  ])("drops a fragment that could carry a secret (%s)", (fragment) => {
    window.history.replaceState(null, "", `/oauth/callback?code=c${fragment}`);
    captureOAuthCallbackFromUrl();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(fragment.slice(1));
  });

  it("keeps a fragment of non-secret keys", () => {
    window.history.replaceState(null, "", "/oauth/callback?code=c#tab=tools");
    captureOAuthCallbackFromUrl();
    expect(window.location.hash).toBe("#tab=tools");
  });

  it("never writes the code to storage", () => {
    window.history.replaceState(
      null,
      "",
      "/oauth/callback?code=one-time-code&state=s",
    );
    captureOAuthCallbackFromUrl();
    expect(readOAuthCallbackParams()?.get("code")).toBe("one-time-code");
    expect(storageText()).not.toContain("one-time-code");
  });

  it("still captures and scrubs when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    window.history.replaceState(null, "", "/oauth/callback?code=c&state=s");
    expect(captureOAuthCallbackFromUrl()).toBe(true);
    expect(window.location.search).toBe("?oauth_pending=1");
    expect(readOAuthCallbackParams()?.get("code")).toBe("c");
  });

  it("leaves a URL the credential registry sees no secret in", () => {
    window.history.replaceState(
      null,
      "",
      "/oauth/callback?code=one-time-code&state=s",
    );
    expect(
      containsCredential(
        `${window.location.pathname}${window.location.search}`,
      ),
    ).toBe(true);
    captureOAuthCallbackFromUrl();
    expect(
      containsCredential(
        `${window.location.pathname}${window.location.search}`,
      ),
    ).toBe(false);
  });
});

describe("reading the inbox", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/oauth/callback?code=c&state=s");
    captureOAuthCallbackFromUrl();
  });

  it("is non-destructive and hands out copies", () => {
    const first = readOAuthCallbackParams();
    first?.delete("code");
    expect(readOAuthCallbackParams()?.get("code")).toBe("c");
    expect(readOAuthCallbackParams()?.get("code")).toBe("c");
    expect(hasPendingOAuthCallback()).toBe(true);
  });

  it("answers only while the callback route is showing", () => {
    window.history.replaceState(null, "", "/servers");
    expect(readOAuthCallbackParams()).toBeNull();
    expect(hasPendingOAuthCallback()).toBe(false);
  });

  it("does not answer for a different callback pathname", () => {
    window.history.replaceState(
      null,
      "",
      "/oauth/callback/debug?oauth_pending=1",
    );
    expect(readOAuthCallbackParams()).toBeNull();
  });

  it("stops answering once the marker is gone from the URL", () => {
    window.history.replaceState(null, "", "/oauth/callback");
    expect(readOAuthCallbackParams()).toBeNull();
  });

  it("counts only a code or an error as a pending answer", () => {
    resetOAuthCallbackInboxForTests();
    window.history.replaceState(null, "", "/oauth/callback?state=only");
    captureOAuthCallbackFromUrl();
    expect(readOAuthCallbackParams()?.get("state")).toBe("only");
    expect(hasPendingOAuthCallback()).toBe(false);
  });

  it("consuming returns the answer and clears it", () => {
    expect(consumeOAuthCallbackParams()?.get("code")).toBe("c");
    expect(readOAuthCallbackParams()).toBeNull();
    expect(hasPendingOAuthCallback()).toBe(false);
  });
});

describe("the URL fallback", () => {
  it("reads an unscrubbed callback query as it stands, without scrubbing", () => {
    window.history.replaceState(null, "", "/oauth/callback?code=raw&state=s");
    expect(readOAuthCallbackParams()?.get("code")).toBe("raw");
    expect(hasPendingOAuthCallback()).toBe(true);
    expect(window.location.search).toBe("?code=raw&state=s");
  });

  it("is still scoped to the callback route", () => {
    window.history.replaceState(null, "", "/callback?code=workos");
    expect(readOAuthCallbackParams()).toBeNull();
  });
});

describe("a reload of the pending page", () => {
  it("answers with an explicit error: the code did not survive it", async () => {
    window.history.replaceState(null, "", "/oauth/callback?code=c&state=s");
    captureOAuthCallbackFromUrl();

    const reloaded = await reloadInboxModule();
    expect(reloaded.readOAuthCallbackParams()).toBeNull();
    expect(reloaded.captureOAuthCallbackFromUrl()).toBe(true);
    const params = reloaded.readOAuthCallbackParams();
    expect(params?.get("code")).toBeNull();
    expect(params?.get("error")).toBe(OAUTH_CALLBACK_EXPIRED_ERROR);
    expect(params?.get("error_description")).toBe(
      OAUTH_CALLBACK_EXPIRED_DESCRIPTION,
    );
    expect(reloaded.hasPendingOAuthCallback()).toBe(true);
    expect(window.location.search).toBe("?oauth_pending=1");
  });

  it("answers with an explicit error after the answer was consumed", async () => {
    window.history.replaceState(null, "", "/oauth/callback?code=c&state=s");
    captureOAuthCallbackFromUrl();
    consumeOAuthCallbackParams();

    const reloaded = await reloadInboxModule();
    reloaded.captureOAuthCallbackFromUrl();
    expect(reloaded.readOAuthCallbackParams()?.get("code")).toBeNull();
    expect(reloaded.readOAuthCallbackParams()?.get("error")).toBe(
      OAUTH_CALLBACK_EXPIRED_ERROR,
    );
  });

  it("does not invent an answer for a marker off the callback route", () => {
    window.history.replaceState(null, "", "/servers?oauth_pending=1");
    expect(captureOAuthCallbackFromUrl()).toBe(false);
    expect(readOAuthCallbackParams()).toBeNull();
  });
});

describe("depositing an answer that arrived another way", () => {
  it("returns the marker URL and parks the answer behind it", () => {
    const target = depositOAuthCallbackParams(
      new URLSearchParams("code=desk&state=electron_mcp%3Aone&oauth_pending=1"),
      "/oauth/callback",
    );
    expect(target).toBe("/oauth/callback?oauth_pending=1");
    expect(target).not.toContain("desk");

    window.history.replaceState(null, "", target);
    const params = readOAuthCallbackParams();
    expect(params?.toString()).toBe("code=desk&state=electron_mcp%3Aone");
    expect(storageText()).not.toContain("desk");
  });
});

describe("agreement with the credential registry", () => {
  it.each(["/oauth/callback", "/oauth/callback/debug"])(
    "treats %s as a callback route the registry blocks from replay",
    (pathname) => {
      expect(isOAuthCallbackPath(pathname)).toBe(true);
      expect(isReplayBlockedLocation({ pathname })).toBe(true);
    },
  );

  it("does not claim the WorkOS sign-in callback", () => {
    expect(isOAuthCallbackPath("/callback")).toBe(false);
  });

  it("recognises only its own marker", () => {
    expect(hasOAuthPendingMarker("?oauth_pending=1")).toBe(true);
    expect(hasOAuthPendingMarker("?oauth_pending=0")).toBe(false);
    expect(hasOAuthPendingMarker("?code=c")).toBe(false);
  });
});
