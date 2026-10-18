import assert from "node:assert/strict";
import test from "node:test";
import {
  outerRunWaitMs,
  RUN_WAIT_CEILING_MS,
  startRunWaitClock,
  type RunWaitBudget,
} from "../src/lib/eval-run-wait.js";

/**
 * `--wait` on a run that queues for shared capacity, then finishes its trials
 * a few at a time. The default budget is an idle window that restarts while
 * trials keep finishing; an explicit `--wait-timeout` stays wall-clock time.
 */

function fakeRun(statuses: () => string[]) {
  let walks = 0;
  return {
    walks: () => walks,
    client: {
      async listEvalRunIterations() {
        walks += 1;
        return {
          items: statuses().map((status, i) => ({ id: `it-${i}`, status })),
          nextCursor: null,
        } as never;
      },
    },
  };
}

async function clockFor(
  run: ReturnType<typeof fakeRun>,
  budget: RunWaitBudget
) {
  return await startRunWaitClock({
    client: run.client,
    signal: new AbortController().signal,
    projectId: "proj",
    runId: "run",
    budget,
  });
}

test("the default wait keeps going while trials keep finishing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let done = 0;
  const run = fakeRun(() => [
    ...Array<string>(done).fill("completed"),
    ...Array<string>(10 - done).fill("pending"),
  ]);
  const clock = await clockFor(run, { ms: 1_000, strict: false });

  // A window in which two trials finished: the run is moving, keep waiting.
  done = 2;
  t.mock.timers.tick(1_000);
  assert.equal(await clock.expired(), false);
  // Inside the new window nothing is read at all.
  const walks = run.walks();
  t.mock.timers.tick(500);
  assert.equal(await clock.expired(), false);
  assert.equal(run.walks(), walks);

  // A whole window with no newly finished trial: give up.
  t.mock.timers.tick(500);
  assert.equal(await clock.expired(), true);
});

test("a run that sits queued with nothing finishing still times out", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const run = fakeRun(() => ["pending", "pending"]);
  const clock = await clockFor(run, { ms: 1_000, strict: false });
  t.mock.timers.tick(999);
  assert.equal(await clock.expired(), false);
  t.mock.timers.tick(1);
  assert.equal(await clock.expired(), true);
});

test("trials finished before the wait began are not progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const run = fakeRun(() => ["completed", "failed", "pending"]);
  const clock = await clockFor(run, { ms: 1_000, strict: false });
  t.mock.timers.tick(1_000);
  assert.equal(await clock.expired(), true);
});

test("an explicit --wait-timeout is wall-clock time and reads no trials", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let done = 0;
  const run = fakeRun(() => (done ? ["completed"] : ["pending"]));
  const clock = await clockFor(run, { ms: 1_000, strict: true });
  done = 1;
  t.mock.timers.tick(1_000);
  assert.equal(await clock.expired(), true);
  assert.equal(run.walks(), 0);
});

test("the grading extension moves the deadline in both modes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const run = fakeRun(() => ["completed"]);
  const clock = await clockFor(run, { ms: 1_000, strict: true });
  clock.extend(5_000);
  t.mock.timers.tick(4_999);
  assert.equal(await clock.expired(), false);
  t.mock.timers.tick(1);
  assert.equal(await clock.expired(), true);
});

test("the command budget outlasts a progress-based wait", () => {
  assert.equal(outerRunWaitMs({ ms: 1_000, strict: true }, 10), 1_010);
  assert.equal(
    outerRunWaitMs({ ms: 1_000, strict: false }, 10),
    RUN_WAIT_CEILING_MS + 10
  );
});

test("a trial count that cannot be read counts as no progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let failing = false;
  let done = 0;
  const client = {
    async listEvalRunIterations() {
      if (failing) throw new Error("iterations unavailable");
      return {
        items: [{ id: "a", status: done ? "completed" : "pending" }],
        nextCursor: null,
      } as never;
    },
  };
  const clock = await startRunWaitClock({
    client,
    signal: new AbortController().signal,
    projectId: "proj",
    runId: "run",
    budget: { ms: 1_000, strict: false },
  });
  done = 1;
  failing = true;
  t.mock.timers.tick(1_000);
  assert.equal(await clock.expired(), true);
});
