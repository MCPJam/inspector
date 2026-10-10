#!/usr/bin/env node
/**
 * Claude Code hooks for the slop rules, wired in `.claude/settings.json`.
 * Claude Code passes the event as JSON on stdin; exit 2 hands stderr back to
 * the agent, which then fixes the problem in the same turn.
 *
 *   PreToolUse (Write)        refuse new root files, NOTES-*.md and .spike-* folders
 *   PostToolUse (Edit|Write)  report rules an edit added, and a file growing past FILE_BUDGET lines
 *   Stop                      run the ratchet over the whole change once before the turn ends
 *
 * Any failure of the hook itself exits 0: a broken check must not wedge a session.
 *
 * `.claude/settings.json` skips these hooks in CI. claude-code-action restores
 * `.claude/` from the base branch but runs this file from the PR head, and
 * there it would hold the action's API key and write token.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RULES, countFile, isMeasuredFile } from "./rules.mjs";

export const FILE_BUDGET = 800;

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

function gitShow(path) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: ROOT,
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
        `file is ${lines} lines, over the ${FILE_BUDGET}-line budget, and growing. Split it or put the new code in its own module.`
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

function runStop(input) {
  // Second stop in a row: the agent already saw the report once. Let it end
  // the turn rather than loop on something that needs a human waiver.
  if (input.stop_hook_active) return 0;
  try {
    execFileSync("node", ["scripts/slop/ratchet.mjs"], {
      cwd: ROOT,
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

  const filePath = input.tool_input?.file_path;
  if (!filePath) return 0;
  const path = repoPath(filePath);

  if (input.hook_event_name === "PreToolUse") {
    const problem = checkNewPath(path, existsSync(filePath));
    if (!problem) return 0;
    process.stderr.write(`${problem}\n`);
    return 2;
  }

  if (input.hook_event_name === "PostToolUse") {
    if (path.startsWith("..") || !existsSync(filePath)) return 0;
    const fileBefore = gitShow(path);
    const fileAfter = readFileSync(filePath, "utf8");
    const fragments = editFragments(
      input.tool_name,
      input.tool_input,
      fileBefore,
      fileAfter
    );
    const problem = checkEdit(path, { ...fragments, fileBefore, fileAfter });
    if (!problem) return 0;
    process.stderr.write(`${problem}\n`);
    return 2;
  }
  return 0;
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, not a `file:` URL.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch {
    process.exitCode = 0;
  }
}
