import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REVOKE_SESSION_PATH,
  SIGN_OUT_REVOKE_TOKEN_TIMEOUT_MS,
  startSessionRevocation,
} from "../revoke-session";
import {
  SIGN_OUT_REQUEST_TIMEOUT_MS,
  SIGN_OUT_SUPPRESSION_WINDOW_MS,
} from "../sign-out-latch";

afterEach(() => {
  vi.useRealTimers();
});

describe("startSessionRevocation", () => {
  it("sends the current token to the revoke route as a keepalive request", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));

    await startSessionRevocation(async () => "token-1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Resolved without waiting on the response, which never comes here.
    expect(fetchImpl).toHaveBeenCalledWith(REVOKE_SESSION_PATH, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { Authorization: "Bearer token-1" },
    });
  });

  it.each([
    ["no token", async () => undefined],
    ["an empty token", async () => ""],
    [
      "a refused token read",
      async () => {
        throw new Error("Login required");
      },
    ],
  ])("skips the request when there is %s", async (_label, getAccessToken) => {
    const fetchImpl = vi.fn();

    await expect(
      startSessionRevocation(getAccessToken, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives up on a token that does not arrive in time", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn();

    const started = startSessionRevocation(() => new Promise(() => {}), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_REVOKE_TOKEN_TIMEOUT_MS);

    await expect(started).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never rejects when the request fails, synchronously or not", async () => {
    await expect(
      startSessionRevocation(async () => "token-1", {
        fetchImpl: (() => {
          throw new TypeError("fetch is not available");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    await expect(
      startSessionRevocation(async () => "token-1", {
        fetchImpl: (() =>
          Promise.reject(new TypeError("network"))) as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it("fits inside the sign-out latch alongside the Electron logout wait", () => {
    // The slowest sign-out waits for the token, then for the Electron logout
    // request, and must still navigate while the latch suppresses the
    // refresh failure that sign-out itself causes.
    expect(
      SIGN_OUT_REVOKE_TOKEN_TIMEOUT_MS + SIGN_OUT_REQUEST_TIMEOUT_MS,
    ).toBeLessThan(SIGN_OUT_SUPPRESSION_WINDOW_MS);
  });
});
