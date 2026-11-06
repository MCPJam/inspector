import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeasurementLane, measurePaths } from "./measured-paths.mjs";

test("queued pairs cannot dispatch after an undrained turn fails the shared lane", async () => {
  const lane = createMeasurementLane();
  let release,
    dispatched = false;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const first = lane(async () => {
    await wait;
    throw Error("undrained");
  });
  const second = lane(async () => {
    dispatched = true;
  });
  const settled = Promise.allSettled([first, second]);
  release();
  assert.deepEqual(
    (await settled).map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(dispatched, false);
  await assert.rejects(
    lane(async () => {
      dispatched = true;
    }),
    /undrained/,
  );
  assert.equal(dispatched, false);
});

test("a submitted runtime failure remains a miss while both other paths run", async () => {
  const calls = [];
  const retained = [];
  await measurePaths(
    ["on", "off", "cli"],
    async (path) => {
      calls.push(path);
      if (path === "on") throw Error("agent exited");
    },
    async (path, error) => {
      const sample = {
        failed: true,
        drained: true,
        ms: 60000,
        submittedAt: 100000,
        followupMs: 45000,
      };
      retained.push({ path, error: error.message, ...sample });
      return sample;
    },
    "short",
  );
  assert.deepEqual(calls, ["on", "off", "cli"]);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].ms, 60000);
});

for (const [reason, sample] of Object.entries({
  "fixture failure": {
    drained: true,
    submittedAt: 100000,
    followupMs: 45000,
    protocolFailure: true,
  },
  "missing submission": { drained: true, followupMs: 45000 },
  "late submission": { drained: true, submittedAt: 100000, followupMs: 91000 },
  "unconfirmed cancellation": { submittedAt: 100000, followupMs: 45000 },
}))
  test(`${reason} stops the matched comparison`, async () => {
    const calls = [];
    await measurePaths(
      ["on", "off", "cli"],
      async (path) => {
        calls.push(path);
        throw Error(reason);
      },
      async () => sample,
      "short",
    );
    assert.deepEqual(calls, ["on"]);
  });

test("failed cleanup stops the comparison and propagates", async () => {
  await assert.rejects(
    measurePaths(
      ["on", "off"],
      async () => {
        throw Error("agent exited");
      },
      async () => {
        throw Error("Stop failed");
      },
      "short",
    ),
    /Stop failed/,
  );
});
