import { test } from "node:test";
import assert from "node:assert/strict";
import { ciScope, dependencyClosure } from "./ci-scope.mjs";

const workspaces = [
  { dir: "sdk", name: "@mcpjam/sdk", deps: [] },
  { dir: "cli", name: "@mcpjam/cli", deps: ["@mcpjam/sdk"] },
  { dir: "design-system", name: "@mcpjam/design-system", deps: [] },
  { dir: "chat-ui", name: "@mcpjam/chat-ui", deps: ["@mcpjam/design-system"] },
  {
    dir: "mcpjam-inspector",
    name: "@mcpjam/inspector",
    deps: ["@mcpjam/sdk", "@mcpjam/chat-ui", "react"],
  },
  { dir: "slack-app", name: "@mcpjam/slack-app", deps: [] },
  { dir: "vitest", name: "@mcpjam/vitest", deps: ["@mcpjam/sdk"] },
];
const pr = (files) => ciScope({ isPullRequest: true, files, workspaces });
const full = {
  inspector: "full",
  rest: "full",
  packaging: true,
  app: true,
  code: true,
  build: true,
};

test("Release and manual runs test everything", () => {
  assert.deepEqual(
    ciScope({ isPullRequest: false, files: ["docs/a.md"], workspaces }),
    full
  );
});

test("an empty diff tests everything rather than nothing", () => {
  assert.deepEqual(pr([]), full);
});

test("root files, .github and non-workspace directories test everything", () => {
  for (const file of [
    "package-lock.json",
    ".github/workflows/test.yml",
    "scripts/slop/rules.mjs",
    "examples/foo/index.ts",
  ]) {
    assert.deepEqual(pr(["mcpjam-inspector/client/a.ts", file]), full, file);
  }
});

test("an Inspector-only change runs only the Inspector tests it affects", () => {
  assert.deepEqual(pr(["mcpjam-inspector/client/src/a.tsx"]), {
    inspector: "changed",
    rest: "checks",
    packaging: false,
    app: true,
    code: true,
    build: true,
  });
});

test("a changeset beside an Inspector change keeps the narrow run", () => {
  assert.equal(
    pr(["mcpjam-inspector/server/a.ts", ".changeset/quiet-fox.md"]).inspector,
    "changed"
  );
});

test("Inspector config and test setup run the whole Inspector suite", () => {
  for (const file of [
    "mcpjam-inspector/package.json",
    "mcpjam-inspector/vitest.config.ts",
    "mcpjam-inspector/client/src/test/factories.ts",
  ]) {
    assert.equal(pr([file]).inspector, "full", file);
  }
});

test("a change to an Inspector dependency runs the whole Inspector suite", () => {
  const scope = pr(["design-system/src/button.tsx"]);
  assert.equal(scope.inspector, "full");
  assert.equal(scope.rest, "full");
  assert.equal(scope.packaging, false);
});

test("a workspace the Inspector does not use skips the Inspector suite", () => {
  const scope = pr(["slack-app/src/index.ts"]);
  assert.equal(scope.inspector, "skip");
  assert.equal(scope.app, false);
  assert.equal(scope.rest, "full");
});

test("an SDK change runs packaging, everything that uses the SDK, and the app", () => {
  const scope = pr(["sdk/src/index.ts"]);
  assert.equal(scope.inspector, "full");
  assert.equal(scope.packaging, true);
  assert.equal(scope.app, true);
});

test("docs-only runs the docs-reading tests and skips build and the app", () => {
  assert.deepEqual(pr(["docs/guide.mdx", "internal-docs/x.md"]), {
    inspector: "docs",
    rest: "full",
    packaging: false,
    app: false,
    code: false,
    build: false,
  });
});

test("docs/style.css still runs the build's design check", () => {
  assert.equal(pr(["docs/style.css"]).build, true);
});

test("docs beside a workspace change keep the docs-reading Inspector tests", () => {
  assert.equal(pr(["slack-app/a.ts", "docs/a.md"]).inspector, "docs");
});

test("dependency closure is transitive and survives cycles", () => {
  const closure = dependencyClosure([
    ...workspaces,
    { dir: "a", name: "a", deps: ["b"] },
    { dir: "b", name: "b", deps: ["a"] },
  ]);
  assert.deepEqual(
    [...closure.get("mcpjam-inspector")].sort(),
    ["chat-ui", "design-system", "sdk"]
  );
  assert.deepEqual([...closure.get("a")], ["b"]);
});
