/**
 * The shared decision-summary request/cache controller.
 *
 * Every assertion here is a request storm, a stale paint or a cancelled-read
 * bug that the three consuming surfaces would otherwise be free to reproduce
 * independently. The two that matter most:
 *
 *   - **The concurrency cap is GLOBAL.** A 50-row runs table and an eight-row
 *     suite history are the same budget. A per-surface cap would let the two
 *     of them issue 58 concurrent reads and each be individually "bounded".
 *   - **Abort is on the LAST subscriber, not the first.** Two surfaces showing
 *     the same run share one read, and the one that unmounts first must not
 *     cancel it out from under the one still on screen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvalDecisionSummaryStore,
  DECISION_SUMMARY_BADGE_LIMIT,
  DECISION_SUMMARY_DETAIL_LIMIT,
  decisionSummaryKey,
  isTerminalEvalRunStatus,
} from "../eval-decision-summary-store";
import { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import type { EvalRunDecisionSummary } from "@mcpjam/sdk/contract";

const PASSING = readDecisionSummaryFixture("policyV2-passing");
const FAILING = readDecisionSummaryFixture("measured-failure-at-every-stage");

interface Deferred {
  resolve: (summary: EvalRunDecisionSummary) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  params: { projectId: string; runId: string; limit: number; cursor?: string };
}

/**
 * A fetcher whose every call is held open until the test settles it, so
 * "in flight" is a state the test controls rather than a race it hopes for.
 */
function deferredFetcher() {
  const calls: Deferred[] = [];
  const fetcher = vi.fn(
    (
      params: {
        projectId: string;
        runId: string;
        limit?: number;
        cursor?: string;
      },
      signal?: AbortSignal,
    ) =>
      new Promise<EvalRunDecisionSummary>((resolve, reject) => {
        calls.push({
          resolve,
          reject,
          signal,
          params: { ...params, limit: params.limit ?? 0 },
        });
      }),
  );
  return { calls, fetcher: fetcher as never };
}

const NOOP = () => {};

function detailRequest(runId: string, extra: { revision?: string } = {}) {
  return {
    projectId: "p1",
    runId,
    limit: DECISION_SUMMARY_DETAIL_LIMIT,
    ...extra,
  };
}

describe("isTerminalEvalRunStatus", () => {
  it.each(["completed", "failed", "cancelled", "timed_out"])(
    "treats %s as terminal",
    (status) => {
      expect(isTerminalEvalRunStatus(status)).toBe(true);
    },
  );

  it.each(["pending", "running", undefined, null, ""])(
    "leaves %s lifecycle-only",
    (status) => {
      expect(isTerminalEvalRunStatus(status as string | null | undefined)).toBe(
        false,
      );
    },
  );
});

describe("EvalDecisionSummaryStore", () => {
  let now = 1_000;
  beforeEach(() => {
    now = 1_000;
  });
  const clock = () => now;

  it("runs at most four reads at once and queues the rest", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });

    for (let index = 0; index < 10; index += 1) {
      const request = detailRequest(`run-${index}`);
      store.subscribe(decisionSummaryKey(request), NOOP);
      store.request(request);
    }

    expect(store.activeRequestCount).toBe(4);
    expect(store.queuedRequestCount).toBe(6);
    expect(calls).toHaveLength(4);

    calls[0].resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();

    // One out, one in — never more than four, and never fewer while work is
    // waiting.
    expect(store.activeRequestCount).toBe(4);
    expect(calls).toHaveLength(5);
  });

  it("shares one read between two subscribers on the same page", () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });
    const request = detailRequest("run-1");
    const key = decisionSummaryKey(request);

    store.subscribe(key, NOOP);
    store.subscribe(key, NOOP);
    store.request(request);
    store.request(request);

    expect(calls).toHaveLength(1);
  });

  it("keeps a badge read and a detail read apart", () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });

    const badge = {
      projectId: "p1",
      runId: "run-1",
      limit: DECISION_SUMMARY_BADGE_LIMIT,
    };
    const detail = detailRequest("run-1");
    expect(decisionSummaryKey(badge)).not.toBe(decisionSummaryKey(detail));

    store.subscribe(decisionSummaryKey(badge), NOOP);
    store.subscribe(decisionSummaryKey(detail), NOOP);
    store.request(badge);
    store.request(detail);

    expect(calls.map((call) => call.params.limit)).toEqual([
      DECISION_SUMMARY_BADGE_LIMIT,
      DECISION_SUMMARY_DETAIL_LIMIT,
    ]);
  });

  it("aborts only once the LAST subscriber has left", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });
    const request = detailRequest("run-1");
    const key = decisionSummaryKey(request);

    // Two DISTINCT listeners: a Set would collapse one shared reference into
    // a single subscriber and the test would pass for the wrong reason.
    const releaseFirst = store.subscribe(key, vi.fn());
    const releaseSecond = store.subscribe(key, vi.fn());
    store.request(request);

    releaseFirst();
    expect(calls[0].signal?.aborted).toBe(false);

    releaseSecond();
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("writes nothing for a read that was abandoned mid-flight", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });
    const request = detailRequest("run-1");
    const key = decisionSummaryKey(request);

    const release = store.subscribe(key, NOOP);
    store.request(request);
    release();

    // A late resolution of a cancelled read must not paint.
    calls[0].resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getEntry(key)).toBeUndefined();
  });

  it("drops a queued read that lost its last subscriber before it started", () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });

    const releases = [];
    for (let index = 0; index < 6; index += 1) {
      const request = detailRequest(`run-${index}`);
      releases.push(store.subscribe(decisionSummaryKey(request), NOOP));
      store.request(request);
    }
    expect(store.queuedRequestCount).toBe(2);

    releases[5]();
    expect(store.queuedRequestCount).toBe(1);

    calls[0].resolve(PASSING);
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        expect(
          calls.some((call) => call.params.runId === "run-5"),
        ).toBe(false);
      });
  });

  it("does not re-read inside the stale window, and does after it", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      staleMs: 1_000,
    });
    const request = detailRequest("run-1");
    store.subscribe(decisionSummaryKey(request), NOOP);

    store.request(request);
    calls[0].resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();

    now += 500;
    store.request(request);
    expect(calls).toHaveLength(1);

    now += 600;
    store.request(request);
    // Judge fanout is asynchronous: a terminal run's summary is not frozen,
    // so a cached one ages out rather than being trusted forever.
    expect(calls).toHaveLength(2);
  });

  it("re-reads immediately when the observed run row changes", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      staleMs: 1_000_000,
    });
    const request = detailRequest("run-1", { revision: "completed::failed" });
    store.subscribe(decisionSummaryKey(request), NOOP);

    store.request(request);
    calls[0].resolve(FAILING);
    await Promise.resolve();
    await Promise.resolve();

    store.request(
      detailRequest("run-1", { revision: "completed::failed::judged" }),
    );

    expect(calls).toHaveLength(2);
  });

  it("re-reads once when the row changes while a read is already in flight", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      staleMs: 1_000_000,
    });
    const key = decisionSummaryKey(detailRequest("run-1"));
    store.subscribe(key, NOOP);

    store.request(detailRequest("run-1", { revision: "a" }));
    store.request(detailRequest("run-1", { revision: "b" }));
    expect(calls).toHaveLength(1);

    calls[0].resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    // The entry written from the first read is knowingly stale, so the store
    // is already reading the newer row rather than leaving it on screen.
    expect(store.getEntry(key)).toMatchObject({
      status: "loading",
      revision: "b",
    });
  });

  it("caches an answer-shaped failure instead of retrying it in a loop", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      staleMs: 1_000,
    });
    const request = detailRequest("run-1");
    store.subscribe(decisionSummaryKey(request), NOOP);

    store.request(request);
    calls[0].reject(
      new EvalRunDecisionSummaryError("routeUnavailable", "not served here"),
    );
    await Promise.resolve();
    await Promise.resolve();

    now += 10_000;
    store.request(request);

    // "This deployment does not serve the contract" is still true in ten
    // seconds. Retrying it is a request storm with no possible new answer.
    expect(calls).toHaveLength(1);
  });

  it("ages out a failed READ, which may well succeed next time", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      staleMs: 1_000,
    });
    const request = detailRequest("run-1");
    store.subscribe(decisionSummaryKey(request), NOOP);

    store.request(request);
    calls[0].reject(
      new EvalRunDecisionSummaryError("requestFailed", "network down"),
    );
    await Promise.resolve();
    await Promise.resolve();

    now += 10_000;
    store.request(request);

    expect(calls).toHaveLength(2);
  });

  it("evicts the least recently used page once the cache is full", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      cacheLimit: 2,
      maxActiveRequests: 10,
    });

    for (const runId of ["run-1", "run-2", "run-3"]) {
      store.request(detailRequest(runId));
    }
    for (const call of calls) call.resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.cacheSize).toBe(2);
    expect(store.getEntry(decisionSummaryKey(detailRequest("run-1")))).toBeUndefined();
    expect(store.getEntry(decisionSummaryKey(detailRequest("run-3")))).toBeDefined();
  });

  it("never evicts a page a surface is still showing", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({
      fetcher,
      now: clock,
      cacheLimit: 1,
      maxActiveRequests: 10,
    });

    const pinned = detailRequest("run-1");
    store.subscribe(decisionSummaryKey(pinned), NOOP);
    store.request(pinned);
    store.request(detailRequest("run-2"));
    for (const call of calls) call.resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getEntry(decisionSummaryKey(pinned))).toBeDefined();
  });

  it("notifies only the subscribers of the key that settled", async () => {
    const { calls, fetcher } = deferredFetcher();
    const store = new EvalDecisionSummaryStore({ fetcher, now: clock });
    const one = vi.fn();
    const two = vi.fn();
    const requestOne = detailRequest("run-1");
    const requestTwo = detailRequest("run-2");

    store.subscribe(decisionSummaryKey(requestOne), one);
    store.subscribe(decisionSummaryKey(requestTwo), two);
    store.request(requestOne);
    store.request(requestTwo);
    one.mockClear();
    two.mockClear();

    calls[0].resolve(PASSING);
    await Promise.resolve();
    await Promise.resolve();

    // A late answer for run-1 cannot paint over a surface showing run-2.
    expect(one).toHaveBeenCalled();
    expect(two).not.toHaveBeenCalled();
  });
});
