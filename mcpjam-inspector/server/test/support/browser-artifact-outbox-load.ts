/**
 * Machinery for the browser artifact outbox load harness: a fake Convex that
 * mirrors `recordBrowserArtifacts` (per-call caps of 20 observations / 120
 * steps, upsert keyed by toolCallId and toolCallId+stepIndex) with seeded
 * latency and failures, a session that ledgers everything it enqueues, and
 * the flush/drain/summary helpers the scenarios share. The test file owns the
 * `vi.mock` calls and wires the fake in.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { createBrowserArtifactOutbox } from "../../services/browser-artifact-outbox.js";

const MAX_OBS = 20;
const MAX_STEPS = 120;

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Screenshot upload cost is modelled in event-loop turns, not milliseconds:
 * `setTimeout` has ~15ms granularity on Windows, which would make thousands
 * of uploads dominate every flush duration. Yielding still lets overlapping
 * flushes interleave the way a real upload round trip does.
 */
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

/** mulberry32: same seed ⇒ same latency/failure sequence on both revisions. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BackendOptions = {
  seed: number;
  latencyMs?: [number, number];
  failureRate?: number;
  uploadYields?: [number, number];
};

/** The slice of `recordBrowserArtifacts` args the ledger keys on. */
export type RecordArgs = {
  chatSessionId: string;
  widgetRenderObservations?: Array<{ toolCallId: string }>;
  browserInteractionSteps?: Array<{ toolCallId: string; stepIndex: number }>;
  videoBlobId?: string;
};

export class FakeBackend {
  calls = 0;
  overCapRejections = 0;
  simulatedFailures = 0;
  videoAttaches = 0;
  landedObs = new Map<string, number>();
  landedSteps = new Map<string, number>();
  uploadsPerKey = new Map<string, number>();
  private rng: () => number;
  private uploadRng: () => number;

  constructor(private opts: BackendOptions) {
    this.rng = makeRng(opts.seed);
    this.uploadRng = makeRng(opts.seed ^ 0x5bd1e995);
  }

  /** The session encodes each row's ledger key as its screenshot bytes. */
  async upload(base64: string): Promise<string> {
    const key = Buffer.from(base64, "base64").toString("utf8");
    this.uploadsPerKey.set(key, (this.uploadsPerKey.get(key) ?? 0) + 1);
    const [lo, hi] = this.opts.uploadYields ?? [1, 3];
    const turns = Math.round(lo + this.uploadRng() * (hi - lo));
    for (let i = 0; i < turns; i += 1) await yieldTurn();
    return `blob-${key}`;
  }

  async mutation(_name: string, args: RecordArgs): Promise<unknown> {
    this.calls += 1;
    const obs = args.widgetRenderObservations ?? [];
    const steps = args.browserInteractionSteps ?? [];
    if (obs.length === 0 && steps.length === 0 && !args.videoBlobId) {
      return null;
    }
    if (obs.length > MAX_OBS) {
      this.overCapRejections += 1;
      throw new Error(
        `Too many widget render observations in one call (max ${MAX_OBS})`,
      );
    }
    if (steps.length > MAX_STEPS) {
      this.overCapRejections += 1;
      throw new Error(
        `Too many browser interaction steps in one call (max ${MAX_STEPS})`,
      );
    }
    const [lo, hi] = this.opts.latencyMs ?? [0, 0];
    const ms = lo + this.rng() * (hi - lo);
    if (ms > 0) await sleep(ms);
    const failureRate = this.opts.failureRate ?? 0;
    if (failureRate > 0 && this.rng() < failureRate) {
      this.simulatedFailures += 1;
      throw new Error("simulated 500");
    }
    for (const o of obs) {
      const key = `${args.chatSessionId}|${o.toolCallId}`;
      this.landedObs.set(key, (this.landedObs.get(key) ?? 0) + 1);
    }
    for (const s of steps) {
      const key = `${args.chatSessionId}|${s.toolCallId}|${s.stepIndex}`;
      this.landedSteps.set(key, (this.landedSteps.get(key) ?? 0) + 1);
    }
    if (args.videoBlobId) this.videoAttaches += 1;
    return { observations: obs.length, steps: steps.length };
  }
}

const screenshotFor = (key: string) => Buffer.from(key).toString("base64");

/** One outbox plus the ledger of everything enqueued into it. */
export class Session {
  outbox;
  expectedObs = new Set<string>();
  expectedSteps = new Set<string>();

  constructor(public chatSessionId: string) {
    this.outbox = createBrowserArtifactOutbox({
      chatSessionId,
      convexAuthToken: "token",
      logScope: "load",
    });
  }

  /** A whole turn's artifacts at once, the way the runner's `take` drains. */
  take(turn: number, obsCount: number, stepCount: number) {
    const observations = Array.from({ length: obsCount }, (_, i) => {
      const toolCallId = `tc-${turn}-${i}`;
      const key = `${this.chatSessionId}|${toolCallId}`;
      this.expectedObs.add(key);
      return {
        toolCallId,
        toolName: "create_view",
        serverId: "server-1",
        promptIndex: turn,
        status: "rendered",
        elapsedMs: 12,
        ts: 100 + i,
        screenshotBase64: screenshotFor(key),
      };
    });
    const steps = Array.from({ length: stepCount }, (_, i) => {
      const toolCallId = `tc-${turn}-${i % Math.max(1, obsCount)}`;
      const key = `${this.chatSessionId}|${toolCallId}|${i}`;
      this.expectedSteps.add(key);
      return {
        toolCallId,
        stepIndex: i,
        promptIndex: turn,
        action: "left_click",
        elapsedMs: 8,
        ts: 200 + i,
        screenshotBase64: screenshotFor(key),
      };
    });
    let drained = false;
    this.outbox.take(
      {
        drainNewArtifacts: () => {
          if (drained) return { observations: [], steps: [] };
          drained = true;
          return { observations, steps };
        },
      } as never,
      turn,
    );
  }

  /** One browser step, the way the chat-turn `persist` hook hands it over. */
  takeStep(turn: number, stepIndex: number) {
    const toolCallId = `tc-${turn}-${Math.floor(stepIndex / 10)}`;
    const key = `${this.chatSessionId}|${toolCallId}|${stepIndex}`;
    this.expectedSteps.add(key);
    this.outbox.enqueueSteps(
      [
        {
          toolCallId,
          stepIndex,
          promptIndex: turn,
          action: "left_click",
          elapsedMs: 8,
          ts: 200 + stepIndex,
          screenshotBase64: screenshotFor(key),
        },
      ] as never,
      turn,
    );
  }
}

export type FlushStats = {
  flushes: number;
  timeouts: number;
  errors: number;
  durations: number[];
};

export const newFlushStats = (): FlushStats => ({
  flushes: 0,
  timeouts: 0,
  errors: 0,
  durations: [],
});

/**
 * Call flush the way a runner does: with a caller deadline that abandons the
 * promise but never cancels the work. Returns the (possibly still running)
 * flush promise so a scenario can choose to await or overlap it.
 */
export function flushWithDeadline(
  session: Session,
  deadlineMs: number,
  stats: FlushStats,
) {
  stats.flushes += 1;
  const start = performance.now();
  const promise = session.outbox.flush().then(
    (r) => {
      stats.durations.push(performance.now() - start);
      return r;
    },
    () => {
      stats.errors += 1;
      stats.durations.push(performance.now() - start);
      return { written: 0, pending: -1, videoAttached: false };
    },
  );
  const raced = Promise.race([
    promise.then(() => "done" as const),
    sleep(deadlineMs).then(() => "timeout" as const),
  ]).then((outcome) => {
    if (outcome === "timeout") stats.timeouts += 1;
  });
  return { promise, raced };
}

/** Flush, and wait for both the result and the deadline bookkeeping. */
export async function flushAndWait(
  session: Session,
  deadlineMs: number,
  stats: FlushStats,
) {
  const { promise, raced } = flushWithDeadline(session, deadlineMs, stats);
  const result = await promise;
  await raced;
  return result;
}

/**
 * Flush until the outbox reports nothing pending, or the round budget runs
 * out. Returns the rounds used, or -1 when the budget ran out with rows held.
 */
export async function drain(
  session: Session,
  maxRounds: number,
  deadlineMs: number,
  stats: FlushStats,
): Promise<number> {
  for (let rounds = 0; rounds < maxRounds; rounds += 1) {
    const result = await flushAndWait(session, deadlineMs, stats);
    if (result.pending === 0 && session.outbox.pendingBatchCount === 0) {
      return rounds + 1;
    }
  }
  return -1;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)]!;
}

type RowTally = {
  expected: number;
  lost: number;
  redundant: number;
  reuploaded: number;
};

function tally(backend: FakeBackend, sessions: Session[]): RowTally {
  const out: RowTally = { expected: 0, lost: 0, redundant: 0, reuploaded: 0 };
  const count = (key: string, landed: Map<string, number>) => {
    out.expected += 1;
    const n = landed.get(key) ?? 0;
    if (n === 0) out.lost += 1;
    else out.redundant += n - 1;
    out.reuploaded += Math.max(0, (backend.uploadsPerKey.get(key) ?? 0) - 1);
  };
  for (const s of sessions) {
    for (const key of s.expectedObs) count(key, backend.landedObs);
    for (const key of s.expectedSteps) count(key, backend.landedSteps);
  }
  return out;
}

const pct = (part: number, whole: number) => (whole ? (100 * part) / whole : 0);

export function summarize(
  name: string,
  backend: FakeBackend,
  sessions: Session[],
  stats: FlushStats,
  extra: Record<string, number> = {},
) {
  const rows = tally(backend, sessions);
  const landed = rows.expected - rows.lost;
  return {
    name,
    expectedRows: rows.expected,
    landedRows: landed,
    lostRows: rows.lost,
    lostPct: pct(rows.lost, rows.expected),
    redundantWrites: rows.redundant,
    redundantPct: pct(rows.redundant, landed),
    screenshotsReuploaded: rows.reuploaded,
    screenshotsReuploadedPct: pct(rows.reuploaded, rows.expected),
    mutationCalls: backend.calls,
    overCapRejections: backend.overCapRejections,
    simulatedFailures: backend.simulatedFailures,
    flushes: stats.flushes,
    flushTimeouts: stats.timeouts,
    flushTimeoutPct: pct(stats.timeouts, stats.flushes),
    flushErrors: stats.errors,
    flushP50Ms: percentile(stats.durations, 50),
    flushP95Ms: percentile(stats.durations, 95),
    flushMaxMs: percentile(stats.durations, 100),
    pendingBatchesAtEnd: sessions.reduce(
      (acc, s) => acc + s.outbox.pendingBatchCount,
      0,
    ),
    ...extra,
  };
}

export type Summary = ReturnType<typeof summarize> & {
  heap?: { beforeMB: number; afterMB: number; deltaMB: number };
};

const exposedGc = () => (globalThis as { gc?: () => void }).gc;

/** Heap in use after a forced collection when `--expose-gc` is on. */
export async function heapUsedMB(): Promise<number> {
  const gc = exposedGc();
  if (gc) {
    gc();
    await sleep(20);
    gc();
  }
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

export function writeResults(out: string, results: Summary[]) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        node: process.version,
        gcExposed: typeof exposedGc() === "function",
        results,
      },
      null,
      2,
    ),
  );
}
