import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FILE_BUDGET } from "../slop/hook.mjs";
import { HOOKS_PATH, decide, isCI, main } from "./install.mjs";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));

// Scripts copied into a temp repo resolve `typescript` from there, and it
// has no node_modules. Child processes find the package these tests load.
process.env.NODE_PATH = dirname(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
);

/** A repo with the real slop scripts and hooks, and an origin/main ref. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "git-hooks-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  cpSync(join(SCRIPTS, "slop"), join(repo, "scripts/slop"), {
    recursive: true,
  });
  cpSync(join(SCRIPTS, "git-hooks"), join(repo, "scripts/git-hooks"), {
    recursive: true,
  });
  mkdirSync(join(repo, "sdk/src"), { recursive: true });
  writeFileSync(join(repo, "sdk/src/a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { repo, git };
}

/** `git commit`, returning its exit code and stderr. CI is unset for hooks. */
function commit(repo, ...args) {
  const env = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  const result = spawnSync("git", ["commit", "-qm", "change", ...args], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  return { code: result.status, stderr: result.stderr };
}

describe("installer", () => {
  const { repo, git } = makeRepo();
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("skips CI and non-git directories", () => {
    assert.equal(decide(repo, { CI: "true" }), "skip: CI");
    const plain = mkdtempSync(join(tmpdir(), "not-git-"));
    assert.equal(decide(plain, {}), "skip: not a git checkout");
    rmSync(plain, { recursive: true });
  });

  it("reads CI=false and CI=0 as not CI", () => {
    assert.equal(isCI({ CI: "true" }), true);
    assert.equal(isCI({ CI: "1" }), true);
    assert.equal(isCI({ CI: "false" }), false);
    assert.equal(isCI({ CI: "0" }), false);
    assert.equal(isCI({}), false);
    assert.equal(decide(repo, { CI: "false" }), "install");
  });

  it("installs once, and leaves an existing hooksPath alone", () => {
    assert.equal(decide(repo, {}), "install");
    main(repo, {});
    assert.equal(git("config", "--get", "core.hooksPath").trim(), HOOKS_PATH);
    assert.equal(decide(repo, {}), "skip: already installed");
    git("config", "core.hooksPath", ".husky");
    assert.match(decide(repo, {}), /already \.husky/);
    git("config", "core.hooksPath", HOOKS_PATH);
  });

  it("leaves a repo with its own .git/hooks alone", () => {
    const other = makeRepo();
    writeFileSync(join(other.repo, ".git/hooks/pre-commit"), "#!/bin/sh\n");
    assert.match(decide(other.repo, {}), /already has pre-commit/);
    rmSync(other.repo, { recursive: true, force: true });
  });
});

describe("pre-commit", () => {
  const { repo, git } = makeRepo();
  after(() => rmSync(repo, { recursive: true, force: true }));
  main(repo, {});

  it("blocks a staged type escape, and --no-verify skips it", () => {
    writeFileSync(join(repo, "sdk/src/a.ts"), "export const a = b as any;\n");
    git("add", "sdk/src/a.ts");
    const blocked = commit(repo);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /`as any` casts \| \*\*\+1\*\*/);
    assert.equal(commit(repo, "--no-verify").code, 0);
  });

  it("blocks scratch notes and new root files", () => {
    writeFileSync(join(repo, "NOTES-item-9.md"), "notes\n");
    git("add", "NOTES-item-9.md");
    const blocked = commit(repo);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /scratch notes/);
    git("rm", "-q", "--cached", "NOTES-item-9.md");
    rmSync(join(repo, "NOTES-item-9.md"));
  });

  it("still runs the other check when one script is missing", () => {
    git("mv", "scripts/slop/repo-hygiene.mjs", "scripts/slop/repo-hygiene.off");
    git("commit", "-qm", "drop hygiene", "--no-verify");
    writeFileSync(join(repo, "sdk/src/q.ts"), "export const q = r as any;\n");
    git("add", "sdk/src/q.ts");
    const blocked = commit(repo);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /`as any` casts/);
    git("rm", "-q", "--cached", "sdk/src/q.ts");
    rmSync(join(repo, "sdk/src/q.ts"));
    writeFileSync(join(repo, "sdk/src/clean.ts"), "export const ok = 1;\n");
    git("add", "sdk/src/clean.ts");
    assert.equal(commit(repo).code, 0);
    git("mv", "scripts/slop/repo-hygiene.off", "scripts/slop/repo-hygiene.mjs");
    git("commit", "-qm", "restore hygiene", "--no-verify");
  });

  it("checks only what is staged, not untracked or unstaged work", () => {
    writeFileSync(join(repo, "sdk/src/wip.ts"), "p.catch(() => {});\n");
    writeFileSync(join(repo, "sdk/src/b.ts"), "export const b = 2;\n");
    git("add", "sdk/src/b.ts");
    writeFileSync(join(repo, "sdk/src/b.ts"), "export const b = c as any;\n");
    assert.equal(commit(repo).code, 0);
  });
});

describe("pre-commit during a merge", () => {
  const { repo, git } = makeRepo();
  after(() => rmSync(repo, { recursive: true, force: true }));
  main(repo, {});
  const write = (path, lines) =>
    writeFileSync(join(repo, path), "export const x = 1;\n".repeat(lines));

  write("sdk/src/big.ts", FILE_BUDGET - 10);
  write("sdk/src/mine.ts", FILE_BUDGET - 10);
  git("add", ".");
  git("commit", "-qm", "near the budget", "--no-verify");
  git("branch", "topic");
  // Main pushes big.ts over the budget and adds a cast, as two PRs that each
  // passed CI, or one under a waiver, can.
  write("sdk/src/big.ts", FILE_BUDGET + 10);
  writeFileSync(join(repo, "sdk/src/a.ts"), "export const a = b as any;\n");
  git("commit", "-qam", "main grows", "--no-verify");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "topic");

  it("judges a merge of main by the branch's change, not main's", () => {
    git("merge", "-q", "--no-ff", "--no-commit", "origin/main");
    write("sdk/src/mine.ts", FILE_BUDGET + 10);
    git("add", "sdk/src/mine.ts");
    const blocked = commit(repo);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /sdk\/src\/mine\.ts: \d+ -> \d+ lines/);
    assert.doesNotMatch(blocked.stderr, /big\.ts|as any/);
    git("checkout", "-q", "HEAD", "--", "sdk/src/mine.ts");
    assert.equal(commit(repo).code, 0);
  });

  it("still fails the branch's own budget violation after the merge", () => {
    write("sdk/src/mine.ts", FILE_BUDGET + 10);
    git("add", "sdk/src/mine.ts");
    const blocked = commit(repo);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /sdk\/src\/mine\.ts: \d+ -> \d+ lines/);
  });
});

describe("pre-push", () => {
  const { repo, git } = makeRepo();
  after(() => rmSync(repo, { recursive: true, force: true }));
  const push = (sha) => {
    const env = { ...process.env };
    delete env.CI;
    return spawnSync(join(repo, "scripts/git-hooks/pre-push"), [], {
      cwd: repo,
      encoding: "utf8",
      env,
      input: `refs/heads/topic ${sha} refs/heads/topic ${"0".repeat(40)}\n`,
    });
  };

  it("blocks a branch that adds slop since origin/main", () => {
    writeFileSync(join(repo, "sdk/src/a.ts"), "p.catch(() => {});\n");
    git("commit", "-qam", "swallow", "--no-verify");
    const result = push(git("rev-parse", "HEAD").trim());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refs\/heads\/topic/);
  });

  it("passes a clean branch and ignores branch deletions", () => {
    git("reset", "-q", "--hard", "origin/main");
    writeFileSync(join(repo, "sdk/src/c.ts"), "export const c = 3;\n");
    git("add", ".");
    git("commit", "-qm", "clean", "--no-verify");
    assert.equal(push(git("rev-parse", "HEAD").trim()).status, 0);
    assert.equal(push("0".repeat(40)).status, 0);
  });
});
