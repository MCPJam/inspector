import { test } from "node:test";
import assert from "node:assert/strict";
import { schedule, verdict } from "./qualification.mjs";
function batch(passCount = 40, batchId = "first") {
  return ["text", "tool"].flatMap((workload) =>
    schedule("codex", workload).map(({ paths: order, ...s }) => {
      const matchId = workload + "-" + s.index;
      const entries = order.map((path) => [
        path,
        {
          matchId,
          followupMs: s.waitMs,
          failed: false,
          submittedAt: 1,
          sandboxId: matchId + (path === "off" ? "-off" : "-on"),
          nativeProcess: {
            before: { pid: 10, birth: "1024" },
            after: { pid: path === "off" ? 11 : 10, birth: "1024" },
          },
          event:
            (path === "cli" ? "stdout-" : "painted-") +
            (workload === "text" ? "text" : "tool-start"),
          ms:
            path === "off"
              ? 3000
              : path === "on"
                ? 1800
                : s.index < passCount
                  ? 1000
                  : 800,
        },
      ]);
      return {
        ...s,
        matchId,
        sandboxIds: { off: matchId + "-off", on: matchId + "-on" },
        chatIds: { off: matchId + "-chat-off", on: matchId + "-chat-on" },
        batchId,
        order,
        ...Object.fromEntries(entries),
      };
    }),
  );
}
test("two decisions are separate for each client and workload", () => {
  assert.equal(verdict(batch(), "codex", false).staff, false);
  assert.equal(verdict(batch(37), "codex", true).staff, true);
  assert.equal(verdict(batch(37), "codex", true).broad, false);
  assert.equal(verdict(batch(), "claude-code", true).staff, false);
  assert.equal(verdict(batch().slice(1), "codex", true).staff, false);
});
test("exactly 38 requires an independent matching repeat", () => {
  const first = batch(38);
  assert.equal(verdict(first, "codex", true).broad, false);
  assert.equal(verdict(first, "codex", true, first).broad, false);
  assert.equal(verdict(first, "codex", true, batch(38, "second")).broad, true);
  assert.equal(verdict(batch(39), "codex", true).broad, true);
});
test("a fallback counts as a miss even when it eventually displays text", () => {
  const input = batch();
  input[0].on.nativeProcess.after.birth = "replacement";
  const result = verdict(input, "codex", true);
  assert.equal(result.staff, false);
  assert.equal(result.workloads.text.misses.on, 1);
  assert.equal(result.workloads.text.timeouts.on, 0);
  assert.equal(result.workloads.text.windows.long.count, 10);
});
test("reject mislabeled paint, mismatched history, duplicate pairs and window drift", () => {
  for (const alter of [
    (r) => (r.on.event = "progress"),
    (r) => (r.cli.matchId = "other"),
    (r) => (r.on.followupMs = 1),
    (r) => (r.index = 1),
  ]) {
    const input = batch();
    alter(input[0]);
    assert.throws(() => verdict(input, "codex", true));
  }
});

test("a replaced box or reused PID with a different birth cannot qualify", () => {
  const original = batch();
  original[0].on.sandboxId = "different";
  original[1].on.nativeProcess.after.birth = "new";
  const group = verdict(original, "codex", true).workloads.text;
  assert.equal(group.misses.on, 2);
  assert.equal(group.timeouts.on, 0);
  assert.equal(group.staffSpeedGate, false);
});

test("reject a shared chat or a CLI on another box", () => {
  const shared = batch();
  shared[0].chatIds.off = shared[0].chatIds.on;
  assert.throws(() => verdict(shared, "codex", true));
  const otherBox = batch();
  otherBox[0].cli.sandboxId = otherBox[0].sandboxIds.off;
  assert.equal(verdict(otherBox, "codex", true).workloads.text.misses.cli, 1);
});

test("an unmeasured control cannot create an apparent speedup or a rollout pass", () => {
  for (const reason of [
    "not-submitted",
    "submission-started",
    "Follow-up outside assigned window",
  ]) {
    const input = batch();
    Object.assign(input[0].off, { failed: true, ms: 60000, reason });
    delete input[0].off.submittedAt;
    const result = verdict(input, "codex", true);
    assert.equal(result.staff, false);
    assert.equal(result.workloads.text.measurementValid, false);
    assert.equal(result.workloads.text.protocolFailures.off, 1);
    assert.equal(result.workloads.text.timeouts.off, 0);
  }
});

test("pre-dispatch failures and invalid repeats cannot qualify", () => {
  const first = batch(38);
  const repeat = batch(40, "repeat");
  Object.assign(repeat[0].off, {
    failed: true,
    ms: 60000,
    reason: "Fixture statistics request failed.",
  });
  delete repeat[0].off.submittedAt;
  assert.equal(verdict(first, "codex", true, repeat).broad, false);
  assert.equal(verdict(repeat, "codex", true).staff, false);
  const wrongControl = batch();
  wrongControl[0].off.nativeProcess.after.pid = 10;
  assert.equal(verdict(wrongControl, "codex", true).staff, false);
});

test("a failed submission outside its assigned window is a protocol failure", () => {
  const input = batch();
  Object.assign(input[0].off, { failed: true, ms: 60000, followupMs: 1 });
  const result = verdict(input, "codex", true);
  assert.equal(result.staff, false);
  assert.equal(result.workloads.text.protocolFailures.off, 1);
});
