import {
  attachAuthChallenge,
  extractAuthChallenge,
} from "../src/mcp-client-manager/errors.js";
import { describe, expect, it, vi } from "vitest";
import {
  recoverAuthProviderSession,
  runOperationWithAuthRecovery,
} from "../src/mcp-client-manager/auth-provider-recovery.js";
import { isolateAuthChallenge } from "../src/mcp-client-manager/auth-challenge-isolation.js";

describe("auth provider session recovery", () => {
  it.each([{ status: 404 }, { code: 404 }, { data: { status: 404 } }])(
    "initializes again before retrying an identity-bound session (%j)",
    async (error) => {
      const order: string[] = [];
      const result = await recoverAuthProviderSession({
        error,
        challenged: true,
        reset: async () => {
          order.push("initialize next session");
        },
        retry: async () => {
          order.push("retry");
          return "result";
        },
      });
      expect(order).toEqual(["initialize next session", "retry"]);
      expect(result).toEqual({ recovered: true, result: "result" });
    }
  );
  it("does not replay an ordinary missing tool", async () => {
    const retry = vi.fn();
    const reset = vi.fn();
    expect(
      await recoverAuthProviderSession({
        error: { status: 404 },
        challenged: false,
        retry,
        reset,
      })
    ).toEqual({ recovered: false });
    expect(retry).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
  it("discards an anonymous session after a redirect without replaying", async () => {
    const reset = vi.fn(async () => {});
    const retry = vi.fn();
    expect(
      await recoverAuthProviderSession({
        error: Object.assign(new Error("Sign in"), {
          name: "UnauthorizedError",
        }),
        challenged: true,
        reset,
        retry,
      })
    ).toEqual({ recovered: false });
    expect(reset).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
  it("serializes the same operation and releases a failed call", async () => {
    const manager = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = isolateAuthChallenge(manager, "same", async () => {
      order.push("first");
      await gate;
      throw new Error("401");
    });
    const rejected = expect(first).rejects.toThrow("401");
    const second = isolateAuthChallenge(manager, "same", async () => {
      order.push("second");
    });
    await isolateAuthChallenge(manager, "other", async () => {
      order.push("other");
    });
    expect(order).toEqual(["first", "other"]);
    release();
    await rejected;
    await second;
    expect(order).toEqual(["first", "other", "second"]);
  });
});

describe("refresh error provenance", () => {
  it("keeps the call challenge when refresh throws another error", async () => {
    const original = new Error("HTTP 401");
    const refreshError = new Error("refresh failed");
    const challenge = {
      source: "http_401" as const,
      requiredScope: "read",
      facets: {
        challengeHeader: "bearer" as const,
        hasScope: true,
        hasResourceMetadata: false,
        hasErrorParams: false,
      },
    };
    await expect(
      runOperationWithAuthRecovery({
        run: async () => {
          throw original;
        },
        usesAuthProvider: false,
        attach: (error) => attachAuthChallenge(error, challenge),
        hasChallenge: () => true,
        reset: async () => {},
        refresh: async () => {
          throw refreshError;
        },
      })
    ).rejects.toBe(refreshError);
    expect(refreshError.cause).toBe(original);
    expect(extractAuthChallenge(refreshError)).toEqual(challenge);
  });
  it("does not loop when the new session refuses the call", async () => {
    const run = vi.fn().mockRejectedValue({ status: 404 });
    const reset = vi.fn(async () => {});
    const refresh = vi.fn();
    await expect(
      runOperationWithAuthRecovery({
        run,
        usesAuthProvider: true,
        attach: () => {},
        hasChallenge: () => true,
        reset,
        refresh,
      })
    ).rejects.toEqual({ status: 404 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});
