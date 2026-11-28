import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startJobBearer,
  type RenewResponse,
} from "../scheduled-eval-job-bearer";
import {
  bearerNow,
  bearerTurnAuthorization,
  followBearer,
} from "../../utils/run-bearer";

const T0 = 1_700_000_000_000;

function bearerWith(renew: (body: unknown) => Promise<RenewResponse>) {
  return startJobBearer({
    triggerId: "trig-1",
    leaseToken: "lease-1",
    bearer: "job-token-1",
    bearerExpiresAt: T0 + 120_000,
    renew,
  });
}

const renewed = (bearer: string, bearerExpiresAt: number): RenewResponse => ({
  status: 200,
  body: { ok: true, credentials: { bearer, bearerExpiresAt } },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a scheduled run's job token", () => {
  it("renews at half its life with the lease, and hands every follower the new token", async () => {
    const renew = vi
      .fn()
      .mockResolvedValueOnce(renewed("job-token-2", T0 + 180_000));
    const bearer = bearerWith(renew);
    const applied: string[] = [];
    followBearer(bearer, (token) => applied.push(token));

    await vi.advanceTimersByTimeAsync(59_000);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledWith({
      triggerId: "trig-1",
      leaseToken: "lease-1",
    });
    expect(bearerNow(bearer)).toBe("job-token-2");
    expect(applied).toEqual(["job-token-1", "job-token-2"]);
    expect(await bearerTurnAuthorization(bearer)!.getAuthorization()).toBe(
      "Bearer job-token-2",
    );

    // The next renewal is half of the new token's remaining life away.
    renew.mockResolvedValueOnce(renewed("job-token-3", T0 + 300_000));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bearerNow(bearer)).toBe("job-token-3");
    bearer.stop();
  });

  it("stops the run at its next call once the backend refuses, naming why", async () => {
    const renew = vi.fn().mockResolvedValue({
      status: 403,
      body: { ok: false, error: "owner_not_member" },
    });
    const bearer = bearerWith(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bearer.refusal()).toBe("owner_not_member");
    expect(() => bearer.current()).toThrow(
      "token_renewal_failed: owner_not_member",
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("keeps the last token for the writes that end the run", async () => {
    const renew = vi.fn().mockResolvedValue({
      status: 409,
      body: { ok: false, error: "lease_lost" },
    });
    const bearer = bearerWith(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    const authorization = bearerTurnAuthorization(bearer)!;
    await expect(authorization.getAuthorization()).rejects.toThrow(
      "token_renewal_failed: lease_lost",
    );
    expect(await authorization.getCleanupAuthorization()).toBe(
      "Bearer job-token-1",
    );
    expect(bearer.last()).toBe("job-token-1");
  });

  it("retries a transient failure while the token has time left", async () => {
    const renew = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ status: 502, body: null })
      .mockResolvedValueOnce(renewed("job-token-2", T0 + 240_000));
    const bearer = bearerWith(renew);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bearerNow(bearer)).toBe("job-token-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(bearerNow(bearer)).toBe("job-token-2");
    expect(bearer.refusal()).toBeNull();
    bearer.stop();
  });

  it("makes its last attempt while the token still works", async () => {
    const renew = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const bearer = bearerWith(renew);
    // Half its life, then every 15 s: 60, 75, 90 and 105 s.
    await vi.advanceTimersByTimeAsync(105_000);
    expect(renew).toHaveBeenCalledTimes(4);
    // 15 s left, so the next attempt waits half of it.
    renew.mockResolvedValueOnce(renewed("job-token-2", T0 + 240_000));
    await vi.advanceTimersByTimeAsync(7_500);
    expect(renew).toHaveBeenCalledTimes(5);
    expect(bearerNow(bearer)).toBe("job-token-2");
    bearer.stop();
  });

  it("stops renewing when the run is over", async () => {
    const renew = vi
      .fn()
      .mockResolvedValue(renewed("job-token-2", T0 + 180_000));
    const bearer = bearerWith(renew);
    bearer.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renew).not.toHaveBeenCalled();
  });

  it("leaves a plain token as it is", async () => {
    const applied: string[] = [];
    followBearer("plain-token", (token) => applied.push(token));
    expect(applied).toEqual(["plain-token"]);
    expect(bearerNow("plain-token")).toBe("plain-token");
    expect(bearerTurnAuthorization("plain-token")).toBeUndefined();
  });
});
