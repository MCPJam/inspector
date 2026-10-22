import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { affectsVisuals, changedPaths, selectVisualRun } from "./select.mjs";

function prEvent(base = "a".repeat(40), head = "b".repeat(40)) {
  return {
    repository: { full_name: "MCPJam/inspector" },
    sender: { login: "engineer" },
    pull_request: {
      user: { login: "engineer" },
      base: { sha: base },
      head: { sha: head, repo: { full_name: "MCPJam/inspector" } },
    },
  };
}

test("main captures without consulting an empty diff", () => {
  assert.deepEqual(
    selectVisualRun({
      eventName: "push",
      event: { ref: "refs/heads/main" },
      diff() {
        throw new Error("must not diff main against itself");
      },
    }),
    { capture: true, reason: "main-always", trusted: true },
  );
});

test("rendering dependency changes capture; docs-only changes skip", () => {
  for (const path of [
    "sdk/src/render.ts",
    "evaluators/src/contract/derive.ts",
    "mcpjam-inspector/e2e/visual/app-data.ts",
    "mcpjam-inspector/client/vite.config.ts",
    "mcpjam-inspector/client/vite.config.ts",
    "mcpjam-inspector/shared/theme.ts",
    "package-lock.json",
    "mcpjam-inspector/server/routes/web/flags.ts",
    "design-system/src/tokens.css",
    ".github/workflows/visual.yml",
  ])
    assert.equal(affectsVisuals(path), true, path);
  const result = selectVisualRun({
    eventName: "pull_request",
    event: prEvent(),
    diff: () => ["docs/guide.md"],
  });
  assert.equal(result.capture, false);
});

test("forks and Dependabot are never marked trusted", () => {
  for (const kind of ["fork", "bot", "bot-pr-human-retrigger"]) {
    const event = prEvent();
    if (kind === "fork")
      event.pull_request.head.repo.full_name = "contributor/inspector";
    else if (kind === "bot") event.sender.login = "dependabot[bot]";
    else event.pull_request.user.login = "dependabot[bot]";
    const result = selectVisualRun({
      eventName: "pull_request",
      event,
      diff: () => ["chat-ui/src/chat.tsx"],
    });
    assert.equal(result.capture, true);
    assert.equal(result.trusted, false);
  }
});

test("invalid events and missing git history fail instead of skipping", () => {
  assert.throws(() => selectVisualRun({ eventName: "schedule", event: {} }));
  const event = prEvent("main");
  assert.throws(
    () => selectVisualRun({ eventName: "pull_request", event }),
    /immutable/,
  );
  assert.throws(
    () =>
      selectVisualRun({
        eventName: "pull_request",
        event: prEvent(),
        diff() {
          throw new Error("missing history");
        },
      }),
    /missing history/,
  );
});

test("real git history excludes parent-stack changes and detects moves out of UI", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "visual-selection-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Visual tests");
  git("config", "user.email", "visual@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(cwd, "chat-ui"));
  writeFileSync(join(cwd, "chat-ui/view.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "parent UI change");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, "README.md"), "documentation\n");
  git("add", ".");
  git("commit", "-qm", "child documentation change");
  const head = git("rev-parse", "HEAD");
  assert.equal(
    selectVisualRun({
      eventName: "pull_request",
      event: prEvent(base, head),
      diff: (from, to) => changedPaths(from, to, cwd),
    }).capture,
    false,
  );
  git("mv", "chat-ui/view.ts", "moved.ts");
  git("commit", "-qm", "move rendering input");
  assert.ok(
    changedPaths(head, git("rev-parse", "HEAD"), cwd).some(affectsVisuals),
  );
});

test("manual runs capture even without a PR diff", () => {
  assert.deepEqual(
    selectVisualRun({ eventName: "workflow_dispatch", event: {} }),
    { capture: true, reason: "manual-run", trusted: true },
  );
});
