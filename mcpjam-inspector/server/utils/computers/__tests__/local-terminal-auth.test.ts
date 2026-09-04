import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_TERMINAL_NONCE_TTL_MS,
  MAX_OUTSTANDING_NONCES,
  consumeLocalNonce,
  consumeLocalTerminalNonce,
  issueLocalNonce,
  issueLocalTerminalNonce,
  outstandingLocalTerminalNonceCount,
  resetLocalTerminalNoncesForTests,
} from "../local-terminal-auth.js";

const FINGERPRINT = "a".repeat(64);

/** Every nonce is bound to a consent fingerprint; default to a stable one. */
function issue(projectId: string, fingerprint: string = FINGERPRINT) {
  return issueLocalTerminalNonce(projectId, fingerprint);
}

/**
 * The nonce IS the auth on the local terminal WebSocket — a browser can't send
 * an Authorization header on a handshake. These pin the four properties the WS
 * route depends on: single use, TTL, project binding, and shape.
 */

beforeEach(() => {
  resetLocalTerminalNoncesForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetLocalTerminalNoncesForTests();
});

describe("issueLocalTerminalNonce", () => {
  it("mints a base64url nonce — a valid Sec-WebSocket-Protocol token", () => {
    const { nonce } = issue("proj_1");
    // RFC 6455 restricts the subprotocol header to HTTP tokens: no `+`, `/`
    // or `=` may appear, which is exactly what base64url guarantees.
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(43);
  });

  it("mints a distinct nonce every time", () => {
    const a = issue("proj_1").nonce;
    const b = issue("proj_1").nonce;
    expect(a).not.toBe(b);
  });

  it("reports a deadline one TTL out", () => {
    const before = Date.now();
    const { expiresAtMs } = issue("proj_1");
    expect(expiresAtMs).toBeGreaterThanOrEqual(
      before + LOCAL_TERMINAL_NONCE_TTL_MS - 50
    );
    expect(expiresAtMs).toBeLessThanOrEqual(
      Date.now() + LOCAL_TERMINAL_NONCE_TTL_MS
    );
  });

  it("refuses to mint without a consent fingerprint", () => {
    // A nonce with nothing to re-verify against would be a 60s bypass of revoke.
    expect(() => issueLocalTerminalNonce("proj_1", "")).toThrow(/consent/i);
  });

  it("rejects a project key that isn't one bounded path segment", () => {
    expect(() => issue("../../etc")).toThrow();
    expect(() => issue("a/b")).toThrow();
    expect(() => issue("")).toThrow();
    expect(() => issue("x".repeat(129))).toThrow();
  });
});

describe("consumeLocalTerminalNonce", () => {
  it("redeems a fresh nonce and returns the bound project", () => {
    const { nonce } = issue("proj_1");
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1", consentFingerprint: FINGERPRINT });
  });

  it("is SINGLE USE — a replayed handshake gets nothing", () => {
    const { nonce } = issue("proj_1");
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1", consentFingerprint: FINGERPRINT });
    expect(consumeLocalTerminalNonce(nonce)).toBeNull();
  });

  it("binds to the project it was minted for", () => {
    const a = issue("proj_a").nonce;
    const b = issue("proj_b").nonce;
    expect(consumeLocalTerminalNonce(a)).toEqual({ projectId: "proj_a", consentFingerprint: FINGERPRINT });
    expect(consumeLocalTerminalNonce(b)).toEqual({ projectId: "proj_b", consentFingerprint: FINGERPRINT });
  });

  it("rejects an unknown, empty, or non-string presentation", () => {
    issue("proj_1");
    expect(consumeLocalTerminalNonce("not-a-real-nonce")).toBeNull();
    expect(consumeLocalTerminalNonce("")).toBeNull();
    expect(consumeLocalTerminalNonce(null)).toBeNull();
    expect(consumeLocalTerminalNonce(undefined)).toBeNull();
    // A rejected presentation must not consume the legitimate outstanding one.
    expect(outstandingLocalTerminalNonceCount()).toBe(1);
  });

  it("rejects a nonce that is a PREFIX of the real one (length is compared)", () => {
    const { nonce } = issue("proj_1");
    expect(consumeLocalTerminalNonce(nonce.slice(0, 8))).toBeNull();
    expect(consumeLocalTerminalNonce(`${nonce}x`)).toBeNull();
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1", consentFingerprint: FINGERPRINT });
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    const { nonce } = issue("proj_1");
    vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS + 1);
    expect(consumeLocalTerminalNonce(nonce)).toBeNull();
  });

  it("is still redeemable just inside the TTL", () => {
    vi.useFakeTimers();
    const { nonce } = issue("proj_1");
    vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS - 1_000);
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1", consentFingerprint: FINGERPRINT });
  });

  it("prunes expired nonces so the store can't grow without bound", () => {
    vi.useFakeTimers();
    issue("proj_1");
    issue("proj_2");
    expect(outstandingLocalTerminalNonceCount()).toBe(2);
    vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS + 1);
    expect(outstandingLocalTerminalNonceCount()).toBe(0);
  });

  it("carries the consent fingerprint it was minted against", () => {
    const other = "b".repeat(64);
    const { nonce } = issue("proj_1", other);
    // The WS handler compares this against the LIVE capability, so a revoke or
    // a re-grant (which rotates the hash) invalidates the nonce.
    expect(consumeLocalTerminalNonce(nonce)).toEqual({
      projectId: "proj_1",
      consentFingerprint: other,
    });
  });

  it("caps outstanding nonces, evicting the oldest rather than locking a user out", () => {
    const first = issue("proj_1").nonce;
    // Derived from the exported cap, so raising it can't silently invalidate
    // this test's premise.
    for (let i = 0; i < MAX_OUTSTANDING_NONCES + 16; i += 1) issue("proj_1");
    const newest = issue("proj_1").nonce;
    expect(outstandingLocalTerminalNonceCount()).toBeLessThanOrEqual(
      MAX_OUTSTANDING_NONCES
    );
    // The oldest was evicted; the newest — the one the user is about to
    // present — still works.
    expect(consumeLocalTerminalNonce(first)).toBeNull();
    expect(consumeLocalTerminalNonce(newest)).toEqual({ projectId: "proj_1", consentFingerprint: FINGERPRINT });
  });
});

/**
 * One pool, two capabilities. A nonce authorizes EITHER a shell on this
 * machine or a stream of the agent browser's screen; letting one stand in for
 * the other would make the kind decorative.
 */
describe("nonce kinds", () => {
  const frames = (projectId: string) =>
    issueLocalNonce({
      kind: "browser-frames",
      projectId,
      consentFingerprint: FINGERPRINT,
    });

  it("redeems a nonce only under the kind it was minted for", () => {
    const { nonce } = frames("proj-a");
    expect(consumeLocalNonce("browser-frames", nonce)).toMatchObject({
      projectId: "proj-a",
    });
  });

  it("refuses a frames nonce at the terminal door, and spends it anyway", () => {
    // Spent either way on purpose: leaving a mismatched nonce outstanding
    // would let a caller learn which kind it is by trying both.
    const { nonce } = frames("proj-a");
    expect(consumeLocalTerminalNonce(nonce)).toBeNull();
    expect(consumeLocalNonce("browser-frames", nonce)).toBeNull();
  });

  it("refuses a terminal nonce at the frames door", () => {
    const { nonce } = issue("proj-a");
    expect(consumeLocalNonce("browser-frames", nonce)).toBeNull();
  });

  it("refuses an expired frames nonce", () => {
    vi.useFakeTimers();
    try {
      const { nonce } = frames("proj-a");
      vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS + 1);
      expect(consumeLocalNonce("browser-frames", nonce)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an empty or absent nonce without scanning for one", () => {
    frames("proj-a");
    expect(consumeLocalNonce("browser-frames", "")).toBeNull();
    expect(consumeLocalNonce("browser-frames", null)).toBeNull();
    expect(consumeLocalNonce("browser-frames", undefined)).toBeNull();
    expect(outstandingLocalTerminalNonceCount()).toBe(1);
  });

  it("carries the project it was minted for, which is what binds the socket", () => {
    // The frames socket compares this against the session it was asked to
    // watch: without that, a nonce for one project opens another's browser.
    const { nonce } = frames("proj-b");
    expect(consumeLocalNonce("browser-frames", nonce)?.projectId).toBe("proj-b");
  });
});
