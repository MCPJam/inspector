/**
 * Load harness for the browser artifact outbox.
 *
 * Not a regression test: it drives the REAL outbox through the scenarios the
 * outbox exists for (turns over the backend's per-call caps, concurrent
 * sessions, overlapping per-step flushes, slow or failing saves) against the
 * fake Convex in `test/support/browser-artifact-outbox-load.ts`, and records
 * what landed. Run it on the two revisions being compared with
 * OUTBOX_LOAD_OUT=<file.json> and diff the JSON files; rows lost, redundant
 * writes and flush latency are the numbers that matter.
 */
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { performance } from "node:perf_hooks";

import {
  FakeBackend,
  Session,
  drain,
  flushAndWait,
  flushWithDeadline,
  heapUsedMB,
  newFlushStats,
  sleep,
  summarize,
  writeResults,
  type RecordArgs,
  type Summary,
} from "../../test/support/browser-artifact-outbox-load.js";

const mutationMock = vi.fn();
const uploadScreenshotBlobMock = vi.fn();
const uploadVideoBlobMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../utils/mcp-app-widget-capture.js", () => ({
  uploadScreenshotBlob: (...args: unknown[]) =>
    uploadScreenshotBlobMock(...args),
  uploadVideoBlob: (...args: unknown[]) => uploadVideoBlobMock(...args),
}));

function wire(backend: FakeBackend) {
  mutationMock
    .mockReset()
    .mockImplementation((name: string, args: RecordArgs) =>
      backend.mutation(name, args),
    );
  uploadScreenshotBlobMock
    .mockReset()
    .mockImplementation((_target: unknown, base64: string) =>
      backend.upload(base64),
    );
  uploadVideoBlobMock.mockReset().mockResolvedValue("video-1");
}

const results: Summary[] = [];
const LONG = 600_000;

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Opt-in: the harness takes ~10s and only means something as a before/after
// pair, so the regular suite skips it unless an output path is given.
describe.skipIf(!process.env.OUTBOX_LOAD_OUT)(
  "browser artifact outbox under load",
  () => {
    it(
      "S1 large turns: 60 observations + 400 steps per turn, healthy backend",
      async () => {
        const backend = new FakeBackend({ seed: 11 });
        wire(backend);
        const session = new Session("s1");
        const stats = newFlushStats();
        const t0 = performance.now();
        for (let turn = 0; turn < 20; turn += 1) {
          session.take(turn, 60, 400);
          await flushAndWait(session, 5_000, stats);
        }
        const drainRounds = await drain(session, 5, 5_000, stats);
        results.push(
          summarize("S1 large turns", backend, [session], stats, {
            drainRounds,
            wallMs: performance.now() - t0,
          }),
        );
      },
      LONG,
    );

    it(
      "S2 concurrent swarm under caps: 40 sessions x 8 turns, 10-60ms backend",
      async () => {
        const backend = new FakeBackend({ seed: 22, latencyMs: [10, 60] });
        wire(backend);
        const sessions = Array.from(
          { length: 40 },
          (_, i) => new Session(`s2-${i}`),
        );
        const stats = newFlushStats();
        const t0 = performance.now();
        await Promise.all(
          sessions.map(async (session) => {
            for (let turn = 0; turn < 8; turn += 1) {
              session.take(turn, 15, 80);
              await flushAndWait(session, 2_000, stats);
            }
            await drain(session, 3, 2_000, stats);
          }),
        );
        results.push(
          summarize("S2 swarm under caps", backend, sessions, stats, {
            wallMs: performance.now() - t0,
          }),
        );
      },
      LONG,
    );

    it(
      "S3 concurrent swarm over caps: 40 sessions x 6 turns of 30 obs + 200 steps, 10-60ms backend",
      async () => {
        const backend = new FakeBackend({ seed: 33, latencyMs: [10, 60] });
        wire(backend);
        const sessions = Array.from(
          { length: 40 },
          (_, i) => new Session(`s3-${i}`),
        );
        const stats = newFlushStats();
        const t0 = performance.now();
        await Promise.all(
          sessions.map(async (session) => {
            for (let turn = 0; turn < 6; turn += 1) {
              session.take(turn, 30, 200);
              await flushAndWait(session, 2_000, stats);
            }
            await drain(session, 3, 2_000, stats);
          }),
        );
        results.push(
          summarize("S3 swarm over caps", backend, sessions, stats, {
            wallMs: performance.now() - t0,
          }),
        );
      },
      LONG,
    );

    it(
      "S4 overlapping flushes: per-step persist on one turn, 150-300ms backend, 25% failures",
      async () => {
        const backend = new FakeBackend({
          seed: 44,
          latencyMs: [150, 300],
          failureRate: 0.25,
          uploadYields: [5, 15],
        });
        wire(backend);
        const session = new Session("s4");
        const stats = newFlushStats();
        const t0 = performance.now();
        const inFlight: Promise<unknown>[] = [];
        // chat-session-turn's `persist` enqueues ONE step and flushes after
        // each browser action, every call racing a 10s deadline. Steps of the
        // same turn arrive faster than a slow backend acknowledges, so flushes
        // overlap on the same promptIndex bucket.
        for (let i = 0; i < 200; i += 1) {
          session.takeStep(0, i);
          const { promise, raced } = flushWithDeadline(session, 10_000, stats);
          inFlight.push(promise, raced);
          await sleep(20);
        }
        await Promise.all(inFlight);
        const drainRounds = await drain(session, 40, 10_000, stats);
        results.push(
          summarize("S4 overlapping flushes", backend, [session], stats, {
            drainRounds,
            wallMs: performance.now() - t0,
          }),
        );
      },
      LONG,
    );

    it(
      "S5 slow and failing backend, sequential flushes under caps: 50-150ms, 30% failures",
      async () => {
        const backend = new FakeBackend({
          seed: 55,
          latencyMs: [50, 150],
          failureRate: 0.3,
        });
        wire(backend);
        const session = new Session("s5");
        const stats = newFlushStats();
        const t0 = performance.now();
        for (let turn = 0; turn < 20; turn += 1) {
          session.take(turn, 15, 90);
          await flushAndWait(session, 1_000, stats);
        }
        const drainRounds = await drain(session, 40, 1_000, stats);
        results.push(
          summarize("S5 slow failing backend", backend, [session], stats, {
            drainRounds,
            wallMs: performance.now() - t0,
          }),
        );
      },
      LONG,
    );

    it(
      "S6 memory: 300 turns of 10 obs + 60 steps through one outbox",
      async () => {
        const backend = new FakeBackend({ seed: 66, uploadYields: [0, 0] });
        wire(backend);
        const session = new Session("s6");
        const stats = newFlushStats();
        const heapBefore = await heapUsedMB();
        const t0 = performance.now();
        for (let turn = 0; turn < 300; turn += 1) {
          session.take(turn, 10, 60);
          await flushAndWait(session, 5_000, stats);
        }
        await drain(session, 3, 5_000, stats);
        const summary = summarize("S6 memory", backend, [session], stats, {
          wallMs: performance.now() - t0,
        });
        // The fake backend's ledger, the session's expected-key sets and the
        // mocks' recorded call arguments grow by design; drop them before
        // measuring so the delta reflects the outbox alone.
        backend.landedObs.clear();
        backend.landedSteps.clear();
        backend.uploadsPerKey.clear();
        session.expectedObs.clear();
        session.expectedSteps.clear();
        mutationMock.mockClear();
        uploadScreenshotBlobMock.mockClear();
        const heapAfter = await heapUsedMB();
        results.push({
          ...summary,
          heap: {
            beforeMB: heapBefore,
            afterMB: heapAfter,
            deltaMB: heapAfter - heapBefore,
          },
        });
      },
      LONG,
    );

    it("writes the results file", () => {
      writeResults(process.env.OUTBOX_LOAD_OUT!, results);
    });
  },
);
