import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_REVOCATION_TIMEOUT_MS,
  revokeAuthKitSession,
} from "../auth-session-revocation.js";

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
