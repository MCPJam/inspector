import { describe, expect, it, vi } from "vitest";
import { busyRetryAfterMs, retryWhileSpendingBusy } from "../stream-busy-retry";

const busy = (retryAfter?: number) =>
  new Response(
    JSON.stringify({
      code: "spending_reservation_busy",
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    }),
    { status: 503 },
  );

describe("busyRetryAfterMs", () => {
  it("reads only a 503 busy refusal, without consuming the body", async () => {
    const res = busy(1_500);
    expect(await busyRetryAfterMs(res)).toBe(1_500);
    expect(await res.text()).toContain("spending_reservation_busy");
    expect(await busyRetryAfterMs(busy())).toBe(2_000);
    expect(
      await busyRetryAfterMs(
        new Response(JSON.stringify({ code: "user_rate_limit" }), {
          status: 503,
        }),
      ),
    ).toBeNull();
    expect(
      await busyRetryAfterMs(
        new Response(JSON.stringify({ code: "spending_reservation_busy" }), {
          status: 429,
        }),
      ),
    ).toBeNull();
    expect(
      await busyRetryAfterMs(new Response("oops", { status: 503 })),
    ).toBeNull();
  });
});

describe("retryWhileSpendingBusy", () => {
  it("returns the first answer that is not busy", async () => {
    const ok = new Response("ok");
    const send = vi.fn().mockResolvedValueOnce(busy(1)).mockResolvedValue(ok);
    expect(await retryWhileSpendingBusy(busy(1), send)).toBe(ok);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("passes any other answer straight through", async () => {
    const send = vi.fn();
    const failed = new Response("nope", { status: 500 });
    expect(await retryWhileSpendingBusy(failed, send)).toBe(failed);
    expect(send).not.toHaveBeenCalled();
  });

  it("gives back the last busy answer once attempts run out", async () => {
    const send = vi.fn().mockImplementation(async () => busy(1));
    const res = await retryWhileSpendingBusy(busy(1), send, {
      maxAttempts: 3,
    });
    expect(res.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws the deadline's reason instead of waiting past it", async () => {
    const controller = new AbortController();
    const send = vi.fn();
    const pending = retryWhileSpendingBusy(busy(5_000), send, {
      signal: controller.signal,
    });
    controller.abort(new Error("turn deadline"));
    await expect(pending).rejects.toThrow("turn deadline");
    expect(send).not.toHaveBeenCalled();
  });
});
