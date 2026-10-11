#!/usr/bin/env node
/**
 * Claude Code hooks for the slop rules, wired in `.claude/settings.json`.
 * Claude Code passes the event as JSON on stdin; exit 2 hands stderr back to
 * the agent, which then fixes the problem in the same turn.
 *
 *   PreToolUse (Write)        refuse new root files, NOTES-*.md and .spike-* folders
 *   PostToolUse (Edit|Write)  report rules an edit added, and a file growing past FILE_BUDGET lines
 *   UserPromptSubmit          note which untracked files exist as the turn begins
 *   Stop                      run the ratchet over the whole change once before the turn ends,
 *                             counting untracked files only if they appeared during the turn
 *
 * Any failure of the hook itself exits 0: a broken check must not wedge a session.
 *
 * `.claude/settings.json` skips these hooks in CI. claude-code-action restores
 * `.claude/` from the base branch but runs this file from the PR head, and
 * there it would hold the action's API key and write token.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RULES, countFile, isMeasuredFile } from "./rules.mjs";

export const FILE_BUDGET = 800;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));

/** Root files that already exist. Anything else at the root needs an RFC. */
const ROOT_ALLOWLIST = new Set([
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
  "railway.json",
]);

/** Git's own error text for a path that is not in HEAD. */
const NOT_IN_HEAD =
  /does not exist in 'HEAD'|exists on disk, but not in 'HEAD'/;

/**
 * The repository that contains `dir`, or null outside one. Hooks act on the
 * session's repository, not the one this script was loaded from: in a git
 * worktree session `$CLAUDE_PROJECT_DIR` can point at the main checkout.
 */
export function repoRootFor(dir) {
  let existing = dir;
  // A Write can target a folder that does not exist yet.
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: existing,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout: there is nothing to compare against.
    return null;
  }
}

/**
 * `p` with symlinks resolved, even when it does not exist yet. git reports
 * the repo root resolved (macOS /var is /private/var), so the edited path
 * must be resolved too or it looks like it is outside the repository.
 */
function resolvedPath(p) {
  let existing = p;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  return join(realpathSync(existing), path.relative(existing, p));
}

function gitShow(path, root) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // New since HEAD: nothing to compare against. Any other failure (no git,
    // no HEAD) rethrows, and the hook exits 0 rather than count the whole
    // file as new.
    if (NOT_IN_HEAD.test(String(error.stderr ?? ""))) return "";
    throw error;
  }
}

/** Repo-relative and `/`-separated, whatever the platform's separator. */
export function repoPath(filePath, root = ROOT, paths = path) {
  return paths.relative(root, filePath).split(paths.sep).join("/");
}

const lineCount = (text) => (text ? text.split("\n").length : 0);

export function checkNewPath(path, exists) {
  if (exists || path.startsWith("..")) return null;
  const name = path.split("/").pop();
  if (/^NOTES[-_].*\.md$/i.test(name)) {
    return `${path}: scratch notes do not belong in the repo. Put the reasoning in the PR description or a docs page.`;
  }
  if (path.split("/").some((part) => part.startsWith(".spike-"))) {
    return `${path}: spike folders stay out of the repo. Keep the spike in a scratch directory and land only the result.`;
  }
  if (!path.includes("/") && !ROOT_ALLOWLIST.has(path)) {
    return `${path}: new root files need a one-page RFC through Q1 2027. Put it in the package it belongs to.`;
  }
  return null;
}

/**
 * `before` / `after` are what the edit replaced and what it wrote: the
 * old_string / new_string of an Edit, or the HEAD version and the new file for
 * a Write. Counting only the edit reports a problem once, on the edit that
 * made it, instead of on every later edit to the same file.
 */
export function checkEdit(path, { before, after, fileBefore, fileAfter }) {
  const problems = [];
  if (isMeasuredFile(path)) {
    const was = countFile(path, before);
    const now = countFile(path, after);
    for (const rule of RULES) {
      const added = now[rule.id] - was[rule.id];
      if (added > 0) problems.push(`${rule.label}: +${added}`);
    }
    const lines = lineCount(fileAfter);
    if (lines > FILE_BUDGET && lines > lineCount(fileBefore)) {
      problems.push(
        `file is ${lines} lines, over the ${FILE_BUDGET}-line budget, and growing. Split it or put the new code in its own module.`,
      );
    }
  }
  if (!problems.length) return null;
  return [
    `${path}: this edit added slop (scripts/slop/rules.mjs):`,
    ...problems.map((problem) => `  - ${problem}`),
    "Fix it now. A best-effort catch needs a reason comment and a debug log; a cast needs a real type.",
  ].join("\n");
}

/** The replaced and written text of an Edit, MultiEdit or Write. */
export function editFragments(toolName, toolInput, headText, fileText) {
  if (toolName === "Edit") {
    return {
      before: toolInput.old_string ?? "",
      after: toolInput.new_string ?? "",
    };
  }
  if (toolName === "MultiEdit") {
    const edits = toolInput.edits ?? [];
    return {
      before: edits.map((edit) => edit.old_string ?? "").join("\n"),
      after: edits.map((edit) => edit.new_string ?? "").join("\n"),
    };
  }
  return { before: headText, after: fileText };
}

/** Where this session's turn-start list of untracked files lives. */
export function snapshotFile(sessionId, root) {
  const key = createHash("sha256")
    .update(`${sessionId ?? ""}\0${root}`)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `slop-hook-untracked-${key}.txt`);
}

function untrackedFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * Untracked files present when the turn begins are someone else's (a
 * person's scratch work, say). Ones that appear during the turn are the
 * agent's, including files a Bash command created, which no Edit or Write
 * hook sees.
 */
function runPromptSubmit(input) {
  const root = repoRootFor(input.cwd ?? process.cwd());
  if (!root) return 0;
  const lines = untrackedFiles(root).join("\n");
  writeFileSync(
    snapshotFile(input.session_id, root),
    lines ? `${lines}\n` : "",
  );
  return 0;
}

function runStop(input) {
  // Second stop in a row: the agent already saw the report once. Let it end
  // the turn rather than loop on something that needs a human waiver.
  if (input.stop_hook_active) return 0;
  const root = repoRootFor(input.cwd ?? process.cwd());
  if (!root) return 0;
  // Without a turn-start snapshot, count tracked files only rather than
  // blame the agent for untracked files it may not have written.
  const snapshot = snapshotFile(input.session_id, root);
  const scope = existsSync(snapshot)
    ? ["--ignore-untracked", snapshot]
    : ["--tracked-only"];
  try {
    execFileSync("node", [join(HERE, "ratchet.mjs"), ...scope], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    if (error.status !== 1) return 0;
    process.stderr.write(`${error.stdout}\n`);
    return 2;
  }
}

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name === "Stop") return runStop(input);
  if (input.hook_event_name === "UserPromptSubmit") {
    return runPromptSubmit(input);
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) return 0;
  const root = repoRootFor(dirname(filePath));
  if (!root) return 0;
  const path = repoPath(resolvedPath(filePath), root);

  if (input.hook_event_name === "PreToolUse") {
    const problem = checkNewPath(path, existsSync(filePath));
    if (!problem) return 0;
    process.stderr.write(`${problem}\n`);
    return 2;
  }

  if (input.hook_event_name === "PostToolUse") {
    if (path.startsWith("..") || !existsSync(filePath)) return 0;
    const fileBefore = gitShow(path, root);
    const fileAfter = readFileSync(filePath, "utf8");
    const fragments = editFragments(
      input.tool_name,
      input.tool_input,
      fileBefore,
      fileAfter,
    );
    const problem = checkEdit(path, { ...fragments, fileBefore, fileAfter });
    if (!problem) return 0;
    process.stderr.write(`${problem}\n`);
    return 2;
  }
  return 0;
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, not a `file:` URL.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = main();
  } catch {
    process.exitCode = 0;
  }
}
