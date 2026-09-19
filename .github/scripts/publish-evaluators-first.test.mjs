import { test } from "node:test";
import assert from "node:assert/strict";
import { publishEvaluatorsFirst } from "./publish-evaluators-first.mjs";
const missing = {
  status: 1,
  stdout: JSON.stringify({ error: { code: "E404" } }),
};
const noSleep = () => {};
test("publishes dependency only after an explicit missing-version response", () => {
  const calls = [];
  assert.equal(
    publishEvaluatorsFirst(
      "0.1.0",
      (args) => {
        calls.push(args);
        if (calls.length === 1) return missing;
        if (args[0] === "publish") return { status: 0, stdout: "" };
        return { status: 0, stdout: '"0.1.0"' };
      },
      noSleep
    ),
    "published"
  );
  assert.deepEqual(calls[1], [
    "publish",
    "--workspace",
    "@mcpjam/evaluators",
    "--access",
    "public",
  ]);
});
test("waits for the registry to serve a just-published version", () => {
  const calls = [];
  const slept = [];
  assert.equal(
    publishEvaluatorsFirst(
      "0.1.0",
      (args) => {
        calls.push(args);
        if (args[0] === "publish") return { status: 0, stdout: "" };
        // The registry keeps 404ing for two reads after the publish returns.
        return calls.length < 5 ? missing : { status: 0, stdout: '"0.1.0"' };
      },
      (ms) => slept.push(ms),
      { attempts: 5, intervalMs: 7 }
    ),
    "published"
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(slept, [7, 7]);
  assert.throws(
    () =>
      publishEvaluatorsFirst(
        "0.1.0",
        (args) => (args[0] === "publish" ? { status: 0, stdout: "" } : missing),
        noSleep,
        { attempts: 3, intervalMs: 0 }
      ),
    /does not serve it yet/
  );
});
test("reruns skip a version already published", () => {
  let calls = 0;
  assert.equal(
    publishEvaluatorsFirst("0.1.0", () => {
      calls++;
      return { status: 0, stdout: '"0.1.0"' };
    }),
    "already-published"
  );
  assert.equal(calls, 1);
});
test("registry and publish errors stop the dependent release", () => {
  assert.throws(
    () =>
      publishEvaluatorsFirst("0.1.0", () => ({
        status: 1,
        stdout: JSON.stringify({ error: { code: "E503" } }),
      })),
    /registry state/
  );
  let calls = 0;
  assert.throws(
    () =>
      publishEvaluatorsFirst(
        "0.1.0",
        () => (++calls === 1 ? missing : { status: 1, stdout: "" }),
        noSleep
      ),
    /publication failed/
  );
});
