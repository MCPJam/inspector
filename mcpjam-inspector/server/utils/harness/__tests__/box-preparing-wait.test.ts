import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broker = vi.hoisted(() => ({
  reserveHarnessBox: vi.fn(),
  startHarnessModelBroker: vi.fn(),
  releaseHarnessBoxReservation: vi.fn(),
}));

vi.mock("../harness-model-broker.js", () => broker);

import {
  BOX_PREPARING_CODE,
  BOX_PREPARING_WAIT_MS,
  STALLED_CLAIM_MS,
  waitOutBoxPreparation,
} from "../box-preparing-wait";
import { HarnessInfraSetupError } from "../harness-provider-error";
import { OrgLeaseTurn } from "../org-lease-turn";

/** A refusal while a preparation holds the box, its claim lapsing then. */
const preparing = (reservationExpiresAt: number) => ({
  ok: false as const,
  status: 409,
  error:
    "This conversation's computer is still being set up. Retry in a moment.",
  code: BOX_PREPARING_CODE,
  reservationExpiresAt,
});
/** A live preparer's claim: renewed every minute, so its expiry moves on. */
const renewed = () =>
  preparing(Math.floor(performance.now() / 60_000) * 60_000 + 300_000);
const STILL_PREPARING = {
  name: "HarnessInfraSetupError",
  evidence: { source: "sandbox_setup", code: BOX_PREPARING_CODE },
};
const BOX = { kind: "sandbox" as const, sandboxRowId: "row_1" };
const LEASE = {
  ok: true as const,
  runId: "run_1",
  expiresAt: Date.now() + 60_000,
  protocol: "anthropic" as const,
  proxyBaseUrl: "https://proxy.test/anthropic",
  delivery: "e2b-network-transform" as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(broker)) mock.mockReset();
  broker.releaseHarnessBoxReservation.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a Send that meets a box being prepared", () => {
  it("keeps waiting while the preparation renews its claim, then proceeds", async () => {
    const startedAt = performance.now();
    const attempt = vi.fn(async () =>
      performance.now() - startedAt < 100_000 ? renewed() : { ok: true },
    );
    const waited = waitOutBoxPreparation(attempt);
    await vi.advanceTimersByTimeAsync(110_000);
    await expect(waited).resolves.toEqual({ ok: true });
  });

  it("runs on the fake clock, not real time", async () => {
    let settled = false;
    const waited = waitOutBoxPreparation(async () => preparing(1)).finally(
      () => {
        settled = true;
      },
    );
    const checked = expect(waited).rejects.toMatchObject(STILL_PREPARING);
    await vi.advanceTimersByTimeAsync(STALLED_CLAIM_MS + 5_000);
    expect(settled).toBe(true);
    await checked;
  });

  it("preparer died: gives up once its claim stops moving, never running beside it", async () => {
    // Claimed, then never renewed: its expiry stays where it was.
    const expiry = Date.now() + 300_000;
    const attempt = vi.fn(async () => preparing(expiry));
    const startedAt = performance.now();
    const waited = waitOutBoxPreparation(attempt);
    const checked = expect(waited).rejects.toMatchObject(STILL_PREPARING);
    await vi.advanceTimersByTimeAsync(STALLED_CLAIM_MS + 5_000);
    await checked;
    expect(performance.now() - startedAt).toBeLessThan(BOX_PREPARING_WAIT_MS);
    // Backed off, not a tight loop.
    expect(attempt.mock.calls.length).toBeLessThan(30);
  });

  it("gives up at the preparation's deadline and a margin, even while its claim moves", async () => {
    const waited = waitOutBoxPreparation(async () => renewed());
    const checked = expect(waited).rejects.toMatchObject(STILL_PREPARING);
    await vi.advanceTimersByTimeAsync(BOX_PREPARING_WAIT_MS - 5_000);
    let settled = false;
    void waited.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await checked;
  });

  it("cuts off a try at the time left, ending typed", async () => {
    const signals: AbortSignal[] = [];
    // A try that hangs until it is cut off, then reads as unreachable.
    const attempt = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ ok: false; status: number; error: string }>((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () =>
            resolve({ ok: false, status: 502, error: "unreachable" }),
          );
        }),
    );
    const waited = waitOutBoxPreparation(attempt);
    const checked = expect(waited).rejects.toMatchObject(STILL_PREPARING);
    await vi.advanceTimersByTimeAsync(BOX_PREPARING_WAIT_MS);
    await checked;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("passes the caller's cancellation to each try, and stops when the turn is cancelled", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const waited = waitOutBoxPreparation(async (signal) => {
      signals.push(signal);
      return renewed();
    }, controller.signal);
    const checked = expect(waited).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await checked;
    expect(signals[0]!.aborted).toBe(true);
  });

  it("does not wait on any other refusal", async () => {
    const busy = { ok: false as const, status: 409, error: "busy" };
    const attempt = vi.fn().mockResolvedValue(busy);
    await expect(waitOutBoxPreparation(attempt)).resolves.toBe(busy);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("the turn's claim and lease start wait out a preparation", () => {
  const turn = () =>
    new OrgLeaseTurn({ harness: "claude-code", authHeader: "Bearer t" });
  const reserveArgs = {
    box: BOX,
    harnessId: "cursor" as const,
    modelId: "cursor/auto",
    runId: "run_1",
    bearer: "Bearer t",
  };

  it("the lease start proceeds once the preparation releases the box, each try bounded", async () => {
    broker.startHarnessModelBroker
      .mockImplementationOnce(async () => renewed())
      .mockResolvedValue(LEASE);
    const started = turn().start({
      box: BOX,
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      runId: "run_1",
      bearer: "Bearer t",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(started).resolves.toMatchObject({ ok: true });
    expect(broker.startHarnessModelBroker).toHaveBeenCalledTimes(2);
    for (const [call] of broker.startHarnessModelBroker.mock.calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("a claim behind a dead preparer ends typed before any lease, and hands back any late claim", async () => {
    broker.reserveHarnessBox.mockResolvedValue(preparing(Date.now()));
    const reserved = turn().reserve(reserveArgs);
    const checked = expect(reserved).rejects.toBeInstanceOf(
      HarnessInfraSetupError,
    );
    await vi.advanceTimersByTimeAsync(STALLED_CLAIM_MS + 5_000);
    await checked;
    expect(broker.startHarnessModelBroker).not.toHaveBeenCalled();
    expect(broker.releaseHarnessBoxReservation).toHaveBeenCalledWith(
      expect.objectContaining({ box: BOX, runId: "run_1" }),
    );
  });

  it("a claim the backend never answered is handed back; a refused one is not", async () => {
    broker.reserveHarnessBox.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    });
    await expect(turn().reserve(reserveArgs)).rejects.toBeInstanceOf(
      HarnessInfraSetupError,
    );
    expect(broker.releaseHarnessBoxReservation).toHaveBeenCalledTimes(1);

    broker.reserveHarnessBox.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "busy",
    });
    await expect(turn().reserve(reserveArgs)).rejects.toBeInstanceOf(
      HarnessInfraSetupError,
    );
    expect(broker.releaseHarnessBoxReservation).toHaveBeenCalledTimes(1);
  });
});
