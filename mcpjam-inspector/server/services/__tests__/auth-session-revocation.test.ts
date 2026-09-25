import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../utils/logger.js", () => ({ logger: loggerMock }));

import {
  MAX_PENDING_SESSION_REVOCATION_RETRIES,
  SESSION_REVOCATION_RETRY_DELAYS_MS,
  SESSION_REVOCATION_TIMEOUT_MS,
  pendingSessionRevocationRetryCount,
  resetSessionRevocationRetriesForTests,
  revokeAuthKitSession,
  revokeSessionWithAcknowledgment,
  scheduleSessionRevocationRetry,
} from "../auth-session-revocation.js";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../revoked-session-cache.js";

/** An unsigned JWT-shaped token carrying a `sid` claim. */
function tokenWithSession(sid: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: "user_1", sid })}.`;
}

const CONVEX_URL = "https://example.convex.cloud";

afterEach(() => {
  vi.useRealTimers();
});

describe("revokeAuthKitSession", () => {
  it("calls the backend mutation as the token's bearer", async () => {
    const revoke = vi.fn().mockResolvedValue({ revoked: true });

    await expect(
      revokeAuthKitSession("token-1", { convexUrl: CONVEX_URL, revoke }),
    ).resolves.toEqual({ revoked: true });
    expect(revoke).toHaveBeenCalledWith(CONVEX_URL, "token-1");
  });

  it("reports a token with no revocable session", async () => {
    const revoke = vi
      .fn()
      .mockResolvedValue({ revoked: false, reason: "no_session" });

    await expect(
      revokeAuthKitSession("token-1", { convexUrl: CONVEX_URL, revoke }),
    ).resolves.toEqual({ revoked: false, reason: "no_session" });
  });

  it("does nothing without a backend to call", async () => {
    const revoke = vi.fn();

    await expect(
      revokeAuthKitSession("token-1", { convexUrl: "", revoke }),
    ).resolves.toEqual({ revoked: false, reason: "not_configured" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("resolves, never rejects, when the call fails", async () => {
    const revoke = vi.fn().mockRejectedValue(new Error("Unauthenticated"));

    await expect(
      revokeAuthKitSession("token-1", { convexUrl: CONVEX_URL, revoke }),
    ).resolves.toEqual({ revoked: false, reason: "failed" });
  });

  it("gives up after its timeout rather than holding a sign-out open", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn(() => new Promise(() => {}));

    const outcome = revokeAuthKitSession("token-1", {
      convexUrl: CONVEX_URL,
      revoke,
    });
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_TIMEOUT_MS);

    await expect(outcome).resolves.toEqual({
      revoked: false,
      reason: "timeout",
    });
  });
});

describe("revokeSessionWithAcknowledgment", () => {
  const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
  let cache: RevokedSessionCache;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    cache = new RevokedSessionCache({
      fetchPage: async () => ({
        sessions: [],
        cursor: null,
        isDone: true,
        watermark: 0,
      }),
    });
    setRevokedSessionCacheForTests(cache);
    loggerMock.info.mockReset();
    loggerMock.error.mockReset();
  });

  afterEach(() => {
    resetSessionRevocationRetriesForTests();
    setRevokedSessionCacheForTests(undefined);
  });

  it("refuses the verified session in this process before the backend answers", async () => {
    let answer!: (value: unknown) => void;
    const revoke = vi.fn(() => new Promise((resolve) => (answer = resolve)));

    const outcome = revokeSessionWithAcknowledgment("token-1", {
      convexUrl: CONVEX_URL,
      revoke,
      verifiedSid: "session_1",
    });

    expect(cache.isRevoked("session_1")).toBe(true);
    answer({ revoked: true });
    await expect(outcome).resolves.toEqual({ revoked: true });
  });

  it("reports revoked only once the backend acknowledges the write", async () => {
    const revoke = vi.fn().mockResolvedValue({ revoked: true });

    await expect(
      revokeSessionWithAcknowledgment("token-1", {
        convexUrl: CONVEX_URL,
        revoke,
        verifiedSid: "session_1",
      }),
    ).resolves.toEqual({ revoked: true });
    expect(pendingSessionRevocationRetryCount()).toBe(0);
  });

  it("records the acknowledged session of a token the gateway did not verify", async () => {
    const revoke = vi.fn().mockResolvedValue({ revoked: true });

    await revokeSessionWithAcknowledgment(tokenWithSession("session_2"), {
      convexUrl: CONVEX_URL,
      revoke,
    });

    expect(cache.isRevoked("session_2")).toBe(true);
  });

  it("does not refuse an unverified session id before the backend has acknowledged it", async () => {
    const revoke = vi.fn().mockResolvedValue({
      revoked: false,
      reason: "no_identity",
    });

    await expect(
      revokeSessionWithAcknowledgment(tokenWithSession("session_3"), {
        convexUrl: CONVEX_URL,
        revoke,
      }),
    ).resolves.toEqual({ revoked: false, reason: "no_identity" });
    expect(cache.isRevoked("session_3")).toBe(false);
    expect(pendingSessionRevocationRetryCount()).toBe(0);
  });

  it("reports a timed-out write as pending, never revoked, and retries until it is acknowledged", async () => {
    const revoke = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce({ revoked: true });

    const outcome = revokeSessionWithAcknowledgment("token-1", {
      convexUrl: CONVEX_URL,
      revoke,
      verifiedSid: "session_1",
    });
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_TIMEOUT_MS);

    await expect(outcome).resolves.toEqual({
      revoked: false,
      reason: "timeout",
      status: "pending",
    });
    // Already refused here while the backend catches up.
    expect(cache.isRevoked("session_1")).toBe(true);
    expect(pendingSessionRevocationRetryCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_RETRY_DELAYS_MS[0]);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(pendingSessionRevocationRetryCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_RETRY_DELAYS_MS[1]);
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenLastCalledWith(CONVEX_URL, "token-1");
    expect(pendingSessionRevocationRetryCount()).toBe(0);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "auth.session.revoke_retry_succeeded",
        attempts: 2,
      }),
    );
  });

  it("gives up after the last retry, and says so", async () => {
    const revoke = vi.fn().mockRejectedValue(new Error("backend unavailable"));

    await expect(
      revokeSessionWithAcknowledgment("token-1", {
        convexUrl: CONVEX_URL,
        revoke,
        verifiedSid: "session_1",
        retryDelaysMs: [10, 20],
      }),
    ).resolves.toEqual({ revoked: false, reason: "failed", status: "pending" });

    await vi.advanceTimersByTimeAsync(30);

    expect(revoke).toHaveBeenCalledTimes(3);
    expect(pendingSessionRevocationRetryCount()).toBe(0);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({ event: "auth.session.revoke_retry_exhausted" }),
    );
  });

  it("joins a retry already pending for the same session", async () => {
    const revoke = vi.fn().mockRejectedValue(new Error("backend unavailable"));
    const options = {
      convexUrl: CONVEX_URL,
      revoke,
      verifiedSid: "session_1",
    };

    await revokeSessionWithAcknowledgment("token-1", options);
    await revokeSessionWithAcknowledgment("token-1", options);

    expect(pendingSessionRevocationRetryCount()).toBe(1);
  });

  it("reports failed when no retry can be scheduled", async () => {
    const revoke = vi.fn().mockRejectedValue(new Error("backend unavailable"));
    for (let i = 0; i < MAX_PENDING_SESSION_REVOCATION_RETRIES; i++) {
      scheduleSessionRevocationRetry(`token-${i}`, {
        convexUrl: CONVEX_URL,
        revoke,
        sid: `session-${i}`,
      });
    }

    await expect(
      revokeSessionWithAcknowledgment("token-extra", {
        convexUrl: CONVEX_URL,
        revoke,
        verifiedSid: "session-extra",
      }),
    ).resolves.toEqual({ revoked: false, reason: "failed", status: "failed" });
    // Still refused in this process.
    expect(cache.isRevoked("session-extra")).toBe(true);
  });
});
