import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { scripts } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

// test:ordered is the one-at-a-time path Windows preflight uses in place of
// test:parallel, so it drifts silently when a workspace joins only one list.
const onlyInOrdered = {
  "@mcpjam/inspector":
    "test:parallel runs it in its own lane beside test:parallel:rest",
};

const workspaces = (script) =>
  new Set([...script.matchAll(/-w\s+(@mcpjam\/[\w-]+)/g)].map((m) => m[1]));

test("test:ordered and test:parallel:rest cover the same workspaces", () => {
  const ordered = workspaces(scripts["test:ordered"]);
  const rest = workspaces(scripts["test:parallel:rest"]);
  assert.deepEqual(
    [...ordered].filter((w) => !rest.has(w) && !(w in onlyInOrdered)),
    [],
    "in test:ordered but not test:parallel:rest"
  );
  assert.deepEqual(
    [...rest].filter((w) => !ordered.has(w)),
    [],
    "in test:parallel:rest but not test:ordered"
  );
  for (const w of Object.keys(onlyInOrdered)) {
    assert.ok(ordered.has(w), `${w} is allowlisted but not in test:ordered`);
    assert.ok(!rest.has(w), `${w} is allowlisted but in test:parallel:rest`);
  }
});
