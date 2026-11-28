import { afterEach, describe, expect, it, vi } from "vitest";
import { warmBridgeWindowMs, warmRetentionFor } from "../warm-retention.js";

const NOW = 1_800_000_000_000;
/** The box's idle window, as the backend sends it. */
const IDLE_MS = 5 * 60_000;
/** The box's ceiling, as the backend sends it for a box that pauses. */
const CEILING = NOW + 4 * 60 * 60_000;

const switchOn = () => vi.stubEnv("MCPJAM_HARNESS_KEEP_THROUGH_PAUSE", "true");

afterEach(() => vi.unstubAllEnvs());

describe("warm retention", () => {
  it("runs the bridge and its marker to the box's ceiling when switched on and sent one", () => {
    switchOn();
    expect(
      warmRetentionFor({ idleMs: IDLE_MS, retainUntil: CEILING }, NOW),
    ).toEqual({ idleMs: IDLE_MS, retainUntil: CEILING });
    // The bridge's own window: the box's remaining lifetime.
    expect(
      warmBridgeWindowMs({ idleMs: IDLE_MS, retainUntil: CEILING }, NOW),
    ).toBe(CEILING - NOW);
  });

  it("keeps today's idle window with the switch off", () => {
    vi.stubEnv("MCPJAM_HARNESS_KEEP_THROUGH_PAUSE", undefined);
    const retention = warmRetentionFor(
      { idleMs: IDLE_MS, retainUntil: CEILING },
      NOW,
    );
    expect(retention).toEqual({ idleMs: IDLE_MS });
    expect(warmBridgeWindowMs({ idleMs: IDLE_MS }, NOW)).toBe(IDLE_MS);
  });

  it("keeps today's idle window for an older backend, a box deleted at its deadline, or a ceiling inside the window", () => {
    switchOn();
    // Neither an older backend nor a box holding plaintext secrets sends one.
    expect(warmRetentionFor({ idleMs: IDLE_MS }, NOW)).toEqual({
      idleMs: IDLE_MS,
    });
    expect(
      warmRetentionFor({ idleMs: IDLE_MS, retainUntil: NOW + IDLE_MS }, NOW),
    ).toEqual({ idleMs: IDLE_MS });
  });

  it("runs no warm agent on a box that sent no idle window, whatever its ceiling", () => {
    switchOn();
    expect(warmRetentionFor({ retainUntil: CEILING }, NOW)).toBeUndefined();
    expect(warmRetentionFor(undefined, NOW)).toBeUndefined();
  });

  it("never gives a kept bridge less than the idle window", () => {
    expect(
      warmBridgeWindowMs({ idleMs: IDLE_MS, retainUntil: NOW + 1_000 }, NOW),
    ).toBe(IDLE_MS);
  });
});
