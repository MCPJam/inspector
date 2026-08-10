import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_TERMINAL_NONCE_TTL_MS,
  MAX_OUTSTANDING_NONCES,
  consumeLocalTerminalNonce,
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
