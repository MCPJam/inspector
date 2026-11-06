import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEvidence,
  saveEvidence,
  cleanupAll,
  cliSignature,
  matchSignature,
  assertFollowupWindow,
  fixtureSnapshot,
  failedMeasurement,
} from "./evidence.mjs";

test("queued turns outside their window are refused before dispatch", () => {
  for (const [window, min, max] of [
    ["short", 30000, 90000],
    ["long", 300000, 600000],
  ]) {
    assert.doesNotThrow(() => assertFollowupWindow(min, window));
    assert.doesNotThrow(() => assertFollowupWindow(max, window));
    assert.throws(() => assertFollowupWindow(max + 1, window));
    assert.throws(() => assertFollowupWindow(min - 1, window));
  }
});

test("fixture receipts require a bounded successful and valid response", async () => {
  const valid = {
    calls: { read_note: 1 },
    methods: [{ method: "tools/call" }],
  };
  assert.deepEqual(
    await fixtureSnapshot("https://fixture.example", async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(valid);
    }),
    valid,
  );
  await assert.rejects(
    fixtureSnapshot(
      "https://fixture.example",
      async () => new Response("no", { status: 503 }),
    ),
    /request failed/,
  );
  await assert.rejects(
    fixtureSnapshot("https://fixture.example", async () =>
      Response.json({ calls: { read_note: -1 }, methods: [] }),
    ),
    /invalid/,
  );
});

test("failed measurements preserve submission proof and instrumentation errors", () => {
  assert.equal(
    failedMeasurement({}, Error("before Send")).submittedAt,
    undefined,
  );
  const after = Object.assign(Error("after Send"), { submittedAt: 12 });
  assert.equal(failedMeasurement({}, after).submittedAt, 12);
  const probe = Object.assign(Error("lost receipts"), {
    protocolFailure: true,
  });
  assert.equal(
    failedMeasurement({ submittedAt: 12 }, probe).protocolFailure,
    true,
  );
});
import { requestMatch } from "./evidence.mjs";

const host = {
  projectId: "project",
  hostId: "host",
  modelId: "openai/gpt-5-mini",
  nativeModel: "gpt-5-mini",
  effort: "low",
  modelSelection: { source: "hosted", modelId: "openai/gpt-5-mini" },
  systemPrompt: "Fixture only",
  serverIds: ["server"],
  cliServers: { fixture: { type: "http", url: "https://fixture.example/mcp" } },
};
const history = [["user", "READY"]];
test("CLI and UI settings independently match, rejecting effort or instruction drift", () => {
  const body = {
    projectId: host.projectId,
    hostId: host.hostId,
    model: { id: host.modelId },
    modelSelection: host.modelSelection,
    reasoningEffort: host.effort,
    systemPrompt: host.systemPrompt,
    requireToolApproval: false,
    selectedServerIds: host.serverIds,
    messages: [{ role: "user", parts: [{ type: "text", text: "READY" }] }],
  };
  const native = {
    model: host.nativeModel,
    effort: host.effort,
    systemPrompt: host.systemPrompt,
    serverNames: ["fixture"],
  };
  assert.equal(
    requestMatch(body, host, history),
    cliSignature(native, host, history),
  );
  assert.throws(() =>
    requestMatch({ ...body, reasoningEffort: "high" }, host, history),
  );
  assert.throws(() =>
    cliSignature({ ...native, systemPrompt: "different" }, host, history),
  );
  assert.notEqual(
    matchSignature(host, history),
    matchSignature(host, [["user", "OTHER"]]),
  );
});
test("an interrupted attempt survives restart and cannot mix manifests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warm-evidence-"));
  const file = join(dir, "row.json");
  try {
    assert.equal(await readEvidence(file, "one"), null);
    const row = {
      manifestHash: "one",
      status: "measuring",
      on: { failed: true, reason: "submission-started" },
    };
    await saveEvidence(file, row);
    assert.deepEqual(await readEvidence(file, "one"), row);
    await assert.rejects(readEvidence(file, "two"), /another run/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cleanup tries every resource even when the CLI and first observer fail", async () => {
  const seen = [];
  await assert.rejects(
    cleanupAll([
      () => {
        seen.push("cli");
        throw Error("cli failure");
      },
      () => {
        seen.push("observer");
        throw Error("observer failure");
      },
      () => {
        seen.push("on box");
      },
      () => {
        seen.push("off box");
      },
    ]),
    AggregateError,
  );
  assert.deepEqual(seen, ["cli", "observer", "on box", "off box"]);
});

test("a failed worker waits for active cleanup and does not start more pairs", async () => {
  const { runConcurrent } = await import("./evidence.mjs");
  const seen = [];
  let finish;
  const ongoing = new Promise((resolve) => {
    finish = resolve;
  });
  const result = runConcurrent([1, 2, 3], 2, async (item) => {
    seen.push(item);
    if (item === 1) throw Error("broken pair");
    await ongoing;
    seen.push("cleaned");
  });
  const rejected = assert.rejects(result, /batch stopped/);
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await rejected;
  assert.deepEqual(seen, [1, 2, "cleaned"]);
});

test("error text and unexecuted or repeated tool cards cannot count as success", async () => {
  const { validateOutput } = await import("./evidence.mjs");
  assert.equal(
    validateOutput(
      { failed: false, output: "Permission denied", ms: 1 },
      "text",
      0,
    ).failed,
    true,
  );
  assert.equal(
    validateOutput({ failed: false, output: "MEASURED", ms: 1 }, "text", 0)
      .failed,
    false,
  );
  for (const calls of [0, 2])
    assert.equal(
      validateOutput({ failed: false, output: "OK", ms: 1 }, "tool", calls)
        .failed,
      true,
    );
  assert.equal(
    validateOutput({ failed: false, output: "OK", ms: 1 }, "tool", 1).failed,
    false,
  );
});
