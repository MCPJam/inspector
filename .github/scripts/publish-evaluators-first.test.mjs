import { test } from "node:test";
import assert from "node:assert/strict";
import { publishEvaluatorsFirst } from "./publish-evaluators-first.mjs";
test("publishes dependency only after an explicit missing-version response", () => {
  const calls = [];
  assert.equal(
    publishEvaluatorsFirst("0.1.0", (args) => {
      calls.push(args);
      return calls.length === 1
        ? { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) }
        : { status: 0, stdout: "" };
    }),
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
      publishEvaluatorsFirst("0.1.0", () =>
        ++calls === 1
          ? { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) }
          : { status: 1, stdout: "" }
      ),
    /publication failed/
  );
});
