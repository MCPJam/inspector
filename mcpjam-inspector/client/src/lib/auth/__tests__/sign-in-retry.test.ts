import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { respondToChatElicitation } from "@/lib/apis/elicitation-api";
import {
  SIGN_IN_EXPIRED_CODE,
  SignInExpiredError,
  retryOnceAfterSignIn,
} from "../sign-in-retry";
import type { ConvexReactClient } from "convex/react";

const refused = () =>
  new ConvexError({
    kind: "unauthenticated",
    message: "Authentication required",
  });

function session(
  patch: Partial<ReturnType<typeof useSessionRefreshStore.getState>>,
) {
  useSessionRefreshStore.setState(patch);
}

describe("retry once after the sign-in comes back", () => {
  beforeEach(() => {
    session({
      status: "idle",
      kind: null,
      queriesPaused: false,
      authConfirmed: true,
      authEpoch: 3,
    });
  });

  it("waits for the session to come back, then sends the call once more", async () => {
    const call = vi
      .fn<() => Promise<string>>()
      // The refusal arrives while the session is being replaced.
      .mockImplementationOnce(async () => {
        session({ authConfirmed: false });
        throw refused();
      })
      .mockResolvedValueOnce("answered");

    const pending = retryOnceAfterSignIn(call, { timeoutMs: 5_000 });
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    session({ authConfirmed: true, authEpoch: 4 });

    await expect(pending).resolves.toBe("answered");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("ends as a described sign-in expiry when the retry is refused too", async () => {
    const call = vi.fn(async () => {
      throw refused();
    });
    session({ authEpoch: 3 });
    const pending = retryOnceAfterSignIn(call, { timeoutMs: 50 });

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignInExpiredError);
    expect((error as SignInExpiredError).code).toBe(SIGN_IN_EXPIRED_CODE);
    expect((error as Error).message).toMatch(/sign-in expired/i);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the session never comes back", async () => {
    const call = vi.fn(async () => {
      session({ authConfirmed: false, queriesPaused: true, status: "failed" });
      throw refused();
    });

    await expect(
      retryOnceAfterSignIn(call, { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(SignInExpiredError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("passes every other failure through untouched", async () => {
    const boom = new Error("not an auth problem");
    const call = vi.fn(async () => {
      throw boom;
    });

    await expect(retryOnceAfterSignIn(call)).rejects.toBe(boom);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("re-sends a form answer the backend refused for missing identity", async () => {
    const mutation = vi
      .fn()
      .mockImplementationOnce(async () => {
        // Convex replaces the token right after the refusal.
        setTimeout(() => session({ authEpoch: 4 }), 10);
        throw refused();
      })
      .mockResolvedValueOnce({ ok: true });
    const convex = { mutation } as unknown as ConvexReactClient;

    const result = await respondToChatElicitation(convex, {
      rendezvousId: "rendezvous-1",
      action: "accept",
      content: { label: "part" },
    });

    expect(result).toEqual({ ok: true });
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(mutation.mock.calls[1]).toEqual(mutation.mock.calls[0]);
  });
});
