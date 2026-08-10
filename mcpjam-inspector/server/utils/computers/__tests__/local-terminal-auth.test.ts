import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_TERMINAL_NONCE_TTL_MS,
  consumeLocalTerminalNonce,
  issueLocalTerminalNonce,
  outstandingLocalTerminalNonceCount,
  resetLocalTerminalNoncesForTests,
} from "../local-terminal-auth.js";

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
    const { nonce } = issueLocalTerminalNonce("proj_1");
    // RFC 6455 restricts the subprotocol header to HTTP tokens: no `+`, `/`
    // or `=` may appear, which is exactly what base64url guarantees.
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(43);
  });

  it("mints a distinct nonce every time", () => {
    const a = issueLocalTerminalNonce("proj_1").nonce;
    const b = issueLocalTerminalNonce("proj_1").nonce;
    expect(a).not.toBe(b);
  });

  it("reports a deadline one TTL out", () => {
    const before = Date.now();
    const { expiresAtMs } = issueLocalTerminalNonce("proj_1");
    expect(expiresAtMs).toBeGreaterThanOrEqual(
      before + LOCAL_TERMINAL_NONCE_TTL_MS - 50
    );
    expect(expiresAtMs).toBeLessThanOrEqual(
      Date.now() + LOCAL_TERMINAL_NONCE_TTL_MS
    );
  });

  it("rejects a project key that isn't one bounded path segment", () => {
    expect(() => issueLocalTerminalNonce("../../etc")).toThrow();
    expect(() => issueLocalTerminalNonce("a/b")).toThrow();
    expect(() => issueLocalTerminalNonce("")).toThrow();
    expect(() => issueLocalTerminalNonce("x".repeat(129))).toThrow();
  });
});

describe("consumeLocalTerminalNonce", () => {
  it("redeems a fresh nonce and returns the bound project", () => {
    const { nonce } = issueLocalTerminalNonce("proj_1");
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1" });
  });

  it("is SINGLE USE — a replayed handshake gets nothing", () => {
    const { nonce } = issueLocalTerminalNonce("proj_1");
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1" });
    expect(consumeLocalTerminalNonce(nonce)).toBeNull();
  });

  it("binds to the project it was minted for", () => {
    const a = issueLocalTerminalNonce("proj_a").nonce;
    const b = issueLocalTerminalNonce("proj_b").nonce;
    expect(consumeLocalTerminalNonce(a)).toEqual({ projectId: "proj_a" });
    expect(consumeLocalTerminalNonce(b)).toEqual({ projectId: "proj_b" });
  });

  it("rejects an unknown, empty, or non-string presentation", () => {
    issueLocalTerminalNonce("proj_1");
    expect(consumeLocalTerminalNonce("not-a-real-nonce")).toBeNull();
    expect(consumeLocalTerminalNonce("")).toBeNull();
    expect(consumeLocalTerminalNonce(null)).toBeNull();
    expect(consumeLocalTerminalNonce(undefined)).toBeNull();
    // A rejected presentation must not consume the legitimate outstanding one.
    expect(outstandingLocalTerminalNonceCount()).toBe(1);
  });

  it("rejects a nonce that is a PREFIX of the real one (length is compared)", () => {
    const { nonce } = issueLocalTerminalNonce("proj_1");
    expect(consumeLocalTerminalNonce(nonce.slice(0, 8))).toBeNull();
    expect(consumeLocalTerminalNonce(`${nonce}x`)).toBeNull();
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1" });
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    const { nonce } = issueLocalTerminalNonce("proj_1");
    vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS + 1);
    expect(consumeLocalTerminalNonce(nonce)).toBeNull();
  });

  it("is still redeemable just inside the TTL", () => {
    vi.useFakeTimers();
    const { nonce } = issueLocalTerminalNonce("proj_1");
    vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS - 1_000);
    expect(consumeLocalTerminalNonce(nonce)).toEqual({ projectId: "proj_1" });
  });

  it("prunes expired nonces so the store can't grow without bound", () => {
    vi.useFakeTimers();
    issueLocalTerminalNonce("proj_1");
    issueLocalTerminalNonce("proj_2");
    expect(outstandingLocalTerminalNonceCount()).toBe(2);
    vi.advanceTimersByTime(LOCAL_TERMINAL_NONCE_TTL_MS + 1);
    expect(outstandingLocalTerminalNonceCount()).toBe(0);
  });

  it("caps outstanding nonces, evicting the oldest rather than locking a user out", () => {
    const first = issueLocalTerminalNonce("proj_1").nonce;
    for (let i = 0; i < 80; i += 1) issueLocalTerminalNonce("proj_1");
    const newest = issueLocalTerminalNonce("proj_1").nonce;
    expect(outstandingLocalTerminalNonceCount()).toBeLessThanOrEqual(64);
    // The oldest was evicted; the newest — the one the user is about to
    // present — still works.
    expect(consumeLocalTerminalNonce(first)).toBeNull();
    expect(consumeLocalTerminalNonce(newest)).toEqual({ projectId: "proj_1" });
  });
});
