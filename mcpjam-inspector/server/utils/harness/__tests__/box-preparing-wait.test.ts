import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broker = vi.hoisted(() => ({
  reserveHarnessBox: vi.fn(),
  startHarnessModelBroker: vi.fn(),
}));

vi.mock("../harness-model-broker.js", () => broker);

import {
  BOX_PREPARING_CODE,
  BOX_PREPARING_WAIT_MS,
  waitOutBoxPreparation,
} from "../box-preparing-wait";
import { HarnessInfraSetupError } from "../harness-provider-error";
import { OrgLeaseTurn } from "../org-lease-turn";

const PREPARING = {
  ok: false as const,
  status: 409,
  error:
    "This conversation's computer is still being set up. Retry in a moment.",
  code: BOX_PREPARING_CODE,
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
  broker.reserveHarnessBox.mockReset();
  broker.startHarnessModelBroker.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a Send that meets a box being prepared", () => {
  it("waits for the preparation to release the box, then proceeds", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(PREPARING)
      .mockResolvedValueOnce(PREPARING)
      .mockResolvedValue({ ok: true });
    const waited = waitOutBoxPreparation(attempt);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(waited).resolves.toEqual({ ok: true });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("does not wait on any other refusal", async () => {
    const busy = { ok: false as const, status: 409, error: "busy" };
    const attempt = vi.fn().mockResolvedValue(busy);
    await expect(waitOutBoxPreparation(attempt)).resolves.toBe(busy);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("preparer died: gives up within the bound, never running beside the claim", async () => {
    // A dead preparer's claim lives until its TTL: every try is refused.
    const attempt = vi.fn().mockResolvedValue(PREPARING);
    const started = Date.now();
    const waited = waitOutBoxPreparation(attempt);
    const settled = expect(waited).rejects.toMatchObject({
      name: "HarnessInfraSetupError",
      evidence: { source: "sandbox_setup", code: BOX_PREPARING_CODE },
    });
    await vi.advanceTimersByTimeAsync(BOX_PREPARING_WAIT_MS);
    await settled;
    expect(Date.now() - started).toBeLessThanOrEqual(BOX_PREPARING_WAIT_MS);
    // Backed off, not a tight loop.
    expect(attempt.mock.calls.length).toBeLessThan(12);
  });

  it("stops waiting when the turn is cancelled", async () => {
    const controller = new AbortController();
    const waited = waitOutBoxPreparation(
      vi.fn().mockResolvedValue(PREPARING),
      controller.signal,
    );
    const settled = expect(waited).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await settled;
  });
});

describe("the turn's claim and lease start wait out a preparation", () => {
  const turn = () =>
    new OrgLeaseTurn({ harness: "claude-code", authHeader: "Bearer t" });

  it("the lease start proceeds once the preparation releases the box", async () => {
    broker.startHarnessModelBroker
      .mockResolvedValueOnce(PREPARING)
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
  });

  it("a claim behind a dead preparer ends in a typed error before any lease", async () => {
    broker.reserveHarnessBox.mockResolvedValue(PREPARING);
    const reserved = turn().reserve({
      box: BOX,
      harnessId: "cursor",
      modelId: "cursor/auto",
      runId: "run_1",
      bearer: "Bearer t",
    });
    const settled = expect(reserved).rejects.toBeInstanceOf(
      HarnessInfraSetupError,
    );
    await vi.advanceTimersByTimeAsync(BOX_PREPARING_WAIT_MS);
    await settled;
    expect(broker.startHarnessModelBroker).not.toHaveBeenCalled();
  });
});
