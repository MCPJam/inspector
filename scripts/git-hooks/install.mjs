#!/usr/bin/env node
/**
 * Point git at scripts/git-hooks, so the slop checks run for every author:
 * people, Claude Code, Codex, Cursor and Devin all commit through git. Run by
 * the root `prepare` script on `npm install`; safe to run by hand.
 *
 * Does nothing in CI, outside a git checkout (Docker builds copy only the
 * manifests), or when the repo already has its own hooks: an existing
 * `core.hooksPath` or a non-sample hook in .git/hooks is left alone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const HOOKS_PATH = "scripts/git-hooks";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** What to do in `cwd`: "install", or a reason to leave the repo alone. */
export function decide(cwd, env = process.env) {
  if (env.CI) return "skip: CI";
  let gitDir;
  try {
    gitDir = git(["rev-parse", "--git-common-dir"], cwd);
  } catch {
    return "skip: not a git checkout";
  }
  let current = "";
  try {
    current = git(["config", "--get", "core.hooksPath"], cwd);
  } catch {
    // Unset: git exits 1 for a missing key.
  }
  if (current === HOOKS_PATH) return "skip: already installed";
  if (current) return `skip: core.hooksPath is already ${current}`;
  const hooksDir = join(
    isAbsolute(gitDir) ? gitDir : join(cwd, gitDir),
    "hooks",
  );
  const own = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((name) => !name.endsWith(".sample"))
    : [];
  if (own.length) return `skip: .git/hooks already has ${own.join(", ")}`;
  return "install";
}

export function main(cwd = process.cwd(), env = process.env) {
  const decision = decide(cwd, env);
  if (decision === "install") {
    git(["config", "core.hooksPath", HOOKS_PATH], cwd);
    console.log(`git hooks: core.hooksPath set to ${HOOKS_PATH}`);
  } else if (
    !decision.startsWith("skip: already") &&
    !decision.startsWith("skip: CI")
  ) {
    console.log(`git hooks not installed (${decision.slice(6)}).`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
