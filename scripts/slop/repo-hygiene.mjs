#!/usr/bin/env node
/**
 * The PR-time half of the agent hooks, so Codex, Cursor and people get the
 * same rules as Claude Code. It reuses `hook.mjs`, so the two cannot disagree.
 *
 *   fails:  a new root file, `NOTES-*.md` or `.spike-*` path;
 *           a source file that crosses FILE_BUDGET lines (new or grown).
 *   warns:  a source file already over FILE_BUDGET that grows. Hundreds of
 *           files are there today, so failing on growth would fail about half
 *           of all PRs; the burn-down shrinks them instead.
 *
 *   node scripts/slop/repo-hygiene.mjs --base HEAD^1
 *
 * SLOP_WAIVER=true reports and exits 0, as for the ratchet.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { FILE_BUDGET, checkNewPath } from "./hook.mjs";
import { isMeasuredFile } from "./rules.mjs";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function lineCountAt(ref, path) {
  try {
    const text = git(["show", `${ref}:${path}`]);
    return text ? text.split("\n").length : 0;
  } catch {
    // Not in that commit: an added or deleted file.
    return 0;
  }
}

/** `[{ status, path }]` from `git diff --name-status -z --no-renames`. */
export function parseNameStatus(output) {
  const fields = output.split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    entries.push({ status: fields[i], path: fields[i + 1] });
  }
  return entries;
}

export function checkChange(entries, linesBefore, linesAfter) {
  const failures = [];
  const warnings = [];
  for (const { status, path } of entries) {
    if (status === "A") {
      const problem = checkNewPath(path, false);
      if (problem) failures.push(problem);
    }
    if (status === "D" || !isMeasuredFile(path)) continue;
    const before = status === "A" ? 0 : linesBefore(path);
    const after = linesAfter(path);
    if (after <= FILE_BUDGET || after <= before) continue;
    if (before <= FILE_BUDGET) {
      failures.push(
        `${path}: ${before} -> ${after} lines, over the ${FILE_BUDGET}-line budget. Put the new code in its own module.`
      );
    } else {
      warnings.push(
        `${path}: already over ${FILE_BUDGET} lines and grew ${before} -> ${after}.`
      );
    }
  }
  return { failures, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = process.argv.indexOf("--base");
  const base =
    index !== -1
      ? process.argv[index + 1]
      : git(["merge-base", "HEAD", "origin/main"]).trim();
  const entries = parseNameStatus(
    git(["diff", "--name-status", "-z", "--no-renames", base, "HEAD"])
  );
  const { failures, warnings } = checkChange(
    entries,
    (path) => lineCountAt(base, path),
    (path) => lineCountAt("HEAD", path)
  );
  const waived = process.env.SLOP_WAIVER === "true";

  const lines = ["## Repo hygiene", ""];
  for (const failure of failures) lines.push(`- **${failure}**`);
  for (const warning of warnings) lines.push(`- ${warning}`);
  if (!failures.length && !warnings.length) lines.push("Nothing to report.");
  if (failures.length && waived) lines.push("", "Waived by `slop-waiver`.");
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  for (const warning of warnings) console.log(`::warning::${warning}`);
  process.exitCode = failures.length && !waived ? 1 : 0;
}
