import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowsDir = path.join(root, ".github/workflows");
const WARMER = "warm-node-modules.yml";

// Every `nm-*` node_modules cache step in a workflow, with what decides whether
// another job can restore it: the key, the `path` list (the cache's version is
// derived from it), the job's container image, the NODE_VERSION its key
// interpolates, and `runs-on` (Blacksmith keeps its own cache store).
function nodeModulesCaches(file) {
  const text = readFileSync(path.join(workflowsDir, file), "utf8");
  const node = /^  NODE_VERSION: "([^"]+)"$/m.exec(text)?.[1] ?? null;
  const jobs = text.slice(text.search(/^jobs:$/m)).split(/^  (?=[\w-]+:\s*$)/m);
  return jobs.flatMap((job) => {
    const container = /^    container: (\S+)$/m.exec(job)?.[1] ?? "none";
    const runsOn = /^    runs-on: (.+)$/m.exec(job)?.[1] ?? null;
    return [...job.matchAll(/^\s+path: \|\n((?:\s+[^\s:]+\n)+)\s+key: (nm-.+)$/gm)].map(
      ([, paths, key]) => JSON.stringify({
        key,
        paths: paths.trim().split(/\s+/),
        container,
        runsOn,
        node,
      })
    );
  });
}

const consumers = () =>
  new Set(
    readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") && f !== WARMER)
      .flatMap(nodeModulesCaches)
  );

test("the consumer workflows are found", () => {
  assert.ok(consumers().size >= 2, "expected test.yml's and lint.yml's caches");
});

// A PR restores these from `main`, and only the warmer saves them there.
test("the warmer saves every node_modules cache a workflow restores", () => {
  const warmed = new Set(nodeModulesCaches(WARMER));
  assert.deepEqual(
    [...consumers()].filter((c) => !warmed.has(c)).map((c) => JSON.parse(c)),
    []
  );
});

test("the warmer saves no cache that nothing restores", () => {
  const used = consumers();
  assert.deepEqual(
    nodeModulesCaches(WARMER)
      .filter((c) => !used.has(c))
      .map((c) => JSON.parse(c)),
    []
  );
});
