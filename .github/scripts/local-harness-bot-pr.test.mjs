// The local-harness pack pipeline's bot PR: one branch and one PR per
// harness, force-updated, never duplicated — run against a real git repo with
// a fake `gh` on PATH that records what it was asked to do.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const script = resolve(import.meta.dirname, "local-harness-bot-pr.sh");
let root;
let origin;
let work;
let bin;
let log;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function run(text, { existing = "" } = {}) {
  return spawnSync("bash", [script, JSON.stringify(text)], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_GH_EXISTING: existing, GITHUB_STEP_SUMMARY: "" },
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "bot-pr-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  bin = join(root, "bin");
  log = join(root, "gh.log");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", origin, work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "pin.json"), "{}\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "init");
  git(work, "push", "origin", "HEAD:main");
  execFileSync("mkdir", ["-p", bin]);
  // `gh pr list` answers FAKE_GH_EXISTING; `gh pr create` answers a URL;
  // everything is logged one call per line.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr list") echo "$FAKE_GH_EXISTING" ;;
  "pr create") echo "https://github.com/o/r/pull/41" ;;
  "pr view") echo "https://github.com/o/r/pull/\${3}" ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

const text = (title) => ({ branch: "bot/local-harness-pack-codex", title, body: "body" });

test("refuses any branch that is not a pack bot branch", () => {
  writeFileSync(join(work, "pin.json"), '{"v":0}\n');
  git(work, "add", "pin.json");
  const result = run({ ...text("x"), branch: "main" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a local-harness pack bot branch/);
  git(work, "reset", "-q", "--hard");
});

test("does nothing when nothing is staged", () => {
  const result = run(text("pin codex pack 1.0.2"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing staged/);
});

test("a different pin force-updates the branch but never inherits the old PR's approval", () => {
  writeFileSync(join(work, "pin.json"), '{"v":2}\n');
  git(work, "add", "pin.json");
  const first = run(text("pin codex pack 1.0.2"));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(git(origin, "log", "-1", "--format=%s", "bot/local-harness-pack-codex"), "pin codex pack 1.0.2");

  // A newer run starts again from main, not from the old bot commit.
  git(work, "switch", "-q", "main");
  writeFileSync(join(work, "pin.json"), '{"v":3}\n');
  git(work, "add", "pin.json");
  const second = run(text("pin codex pack 1.0.3"), { existing: "41" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(git(origin, "log", "-1", "--format=%s", "bot/local-harness-pack-codex"), "pin codex pack 1.0.3");
  assert.equal(git(origin, "rev-list", "--count", "main..bot/local-harness-pack-codex"), "1");

  const calls = readFileSync(log, "utf8").trim().split("\n");
  // The approved 1.0.2 PR is disarmed and closed before the push; 1.0.3 is a
  // new PR that needs its own approval.
  const disarm = calls.findIndex((call) => call.startsWith("pr merge 41 --disable-auto"));
  const close = calls.findIndex((call) => call.startsWith("pr close 41"));
  assert.ok(disarm >= 0 && close > disarm, calls.join("\n"));
  assert.equal(calls.filter((call) => call.startsWith("pr create")).length, 2);
  assert.ok(!calls.some((call) => call.startsWith("pr edit 41")));
  assert.equal(calls.filter((call) => call.startsWith("pr merge") && call.includes("--auto") && !call.includes("--disable-auto")).length, 2);
});

test("a re-run with the same pin keeps the open PR and its approval", () => {
  writeFileSync(log, "");
  git(work, "switch", "-q", "main");
  writeFileSync(join(work, "pin.json"), '{"v":3}\n');
  git(work, "add", "pin.json");
  const rerun = run(text("pin codex pack 1.0.3"), { existing: "42" });
  assert.equal(rerun.status, 0, rerun.stderr);

  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(calls.some((call) => call.startsWith("pr edit 42 --title pin codex pack 1.0.3")), calls.join("\n"));
  assert.ok(!calls.some((call) => call.startsWith("pr close")));
  assert.ok(!calls.some((call) => call.startsWith("pr create")));
});
