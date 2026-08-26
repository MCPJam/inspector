import { afterEach, describe, expect, it, vi } from "vitest";

const setContext = vi.fn();
const event = vi.fn();

vi.mock("@sentry/node", () => ({ setContext }));
vi.mock("../request-logger.js", () => ({
  getSystemLogger: () => ({ event }),
}));

const MB = 1024 * 1024;

/**
 * Drives the sampler by heap size. `flushProcessVitals` reads real V8 numbers,
 * so the heap has to be stubbed to make the emit policy testable at all — the
 * alternative is allocating hundreds of megabytes inside a unit test.
 */
type HeapSpaces = () => {
  space_name: string;
  space_used_size: number;
  space_size: number;
}[];

const DEFAULT_HEAP_SPACES: HeapSpaces = () => [
  { space_name: "old_space", space_used_size: 700 * MB, space_size: 800 * MB },
];

async function loadVitals(
  heapSequence: number[],
  heapSpaces: HeapSpaces = DEFAULT_HEAP_SPACES,
) {
  vi.resetModules();
  let index = 0;
  vi.doMock("node:v8", () => ({
    default: {
      getHeapStatistics: () => ({
        used_heap_size:
          heapSequence[Math.min(index++, heapSequence.length - 1)],
        total_heap_size: 900 * MB,
        heap_size_limit: 4096 * MB,
        external_memory: 15 * MB,
      }),
      getHeapSpaceStatistics: heapSpaces,
    },
  }));
  return import("../process-vitals.js");
}

afterEach(() => {
  setContext.mockClear();
  event.mockClear();
  vi.doUnmock("node:v8");
});

describe("process vitals sampler", () => {
  it("emits the first sample so every session has a baseline", async () => {
    const { flushProcessVitals } = await loadVitals([500 * MB]);

    flushProcessVitals(0);

    expect(event).toHaveBeenCalledTimes(1);
    const [name, payload] = event.mock.calls[0]!;
    expect(name).toBe("process.vitals");
    expect(payload.reason).toBe("startup");
    expect(payload.heapUsedBytes).toBe(500 * MB);
    expect(payload.heapLimitBytes).toBe(4096 * MB);
  });

  // The whole point of the gauge: a session that sits still must not pay a row
  // a minute, or the signal drowns in its own heartbeat.
  it("stays silent while the heap holds steady inside the heartbeat window", async () => {
    const { flushProcessVitals } = await loadVitals([
      500 * MB,
      505 * MB,
      510 * MB,
    ]);

    flushProcessVitals(0);
    flushProcessVitals(60_000);
    flushProcessVitals(120_000);

    expect(event).toHaveBeenCalledTimes(1);
  });

  it("emits on a heap step in either direction", async () => {
    const { flushProcessVitals } = await loadVitals([
      500 * MB,
      600 * MB, // +100 MB: a ramp
      520 * MB, // -80 MB: a full GC, just as worth recording
    ]);

    flushProcessVitals(0);
    flushProcessVitals(60_000);
    flushProcessVitals(120_000);

    expect(event.mock.calls.map(([, p]) => p.reason)).toEqual([
      "startup",
      "heap_step",
      "heap_step",
    ]);
  });

  it("checks in on the heartbeat even when nothing moved", async () => {
    const { flushProcessVitals } = await loadVitals([500 * MB]);

    flushProcessVitals(0);
    flushProcessVitals(9 * 60_000);
    flushProcessVitals(10 * 60_000);

    expect(event.mock.calls.map(([, p]) => p.reason)).toEqual([
      "startup",
      "heartbeat",
    ]);
  });

  // The Sentry context is the only channel that survives a process which dies
  // without flushing, so it must refresh on samples that produce no row.
  it("refreshes the Sentry context on every sample, emitted or not", async () => {
    const { flushProcessVitals } = await loadVitals([500 * MB, 505 * MB]);

    flushProcessVitals(0);
    flushProcessVitals(60_000);

    expect(event).toHaveBeenCalledTimes(1);
    expect(setContext).toHaveBeenCalledTimes(2);
    expect(setContext.mock.calls[1]![0]).toBe("process_vitals");
  });

  it("carries a bounded heap trend so one crash report shows the shape", async () => {
    const { flushProcessVitals } = await loadVitals(
      Array.from({ length: 14 }, (_, i) => (500 + i) * MB),
    );

    for (let i = 0; i < 14; i++) flushProcessVitals(i * 60_000);

    const trend = setContext.mock.calls.at(-1)![1].heapUsedTrendMb;
    // Capped at 10 and oldest-first, so it cannot become the leak it measures.
    expect(trend).toHaveLength(10);
    expect(trend[0]).toBeLessThan(trend[trend.length - 1]);
  });

  // A V8 build that names its spaces differently would otherwise report
  // whatever the last space happened to be.
  it("reports zero old-space numbers when V8 exposes no old_space", async () => {
    const { flushProcessVitals } = await loadVitals([500 * MB], () => []);

    flushProcessVitals(0);

    const [, payload] = event.mock.calls[0]!;
    expect(payload.oldSpaceUsedBytes).toBe(0);
    expect(payload.oldSpaceSizeBytes).toBe(0);
    // The rest of the sample is still worth recording.
    expect(payload.heapUsedBytes).toBe(500 * MB);
  });

  // The rule this sampler is built on: a telemetry timer must never be what
  // takes the process down. A collection that throws produces no row and no
  // exception rather than an unhandled throw inside the interval.
  it("swallows a throwing collection instead of taking the process down", async () => {
    const { flushProcessVitals } = await loadVitals([500 * MB], () => {
      throw new Error("v8 unavailable");
    });

    expect(() => flushProcessVitals(0)).not.toThrow();
    expect(event).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalled();
  });

  it("reports peak heap, not just the current sample", async () => {
    const { flushProcessVitals } = await loadVitals([
      500 * MB,
      900 * MB,
      520 * MB,
    ]);

    flushProcessVitals(0);
    flushProcessVitals(60_000);
    flushProcessVitals(120_000);

    const last = event.mock.calls.at(-1)![1];
    expect(last.heapUsedBytes).toBe(520 * MB);
    expect(last.peakHeapUsedBytes).toBe(900 * MB);
  });
});
