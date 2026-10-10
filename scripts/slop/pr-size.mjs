#!/usr/bin/env node
/**
 * PR size: changed lines of hand-written source, which is what a reviewer
 * actually has to read. Tests, generated and bundled files, lockfiles, docs
 * and `dist` do not count; the filter is `isMeasuredFile` from `rules.mjs`.
 *
 *   over LARGE (400):   reported; the PR should carry `large-pr`.
 *   over LIMIT (1,500): fails unless labelled `mechanical` (moves, codemods).
 *
 *   node scripts/slop/pr-size.mjs --base HEAD^1
 *
 * PR_LABELS is the comma-separated label list; CI fills it from the event.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isMeasuredFile } from "./rules.mjs";

export const LARGE = 400;
export const LIMIT = 1500;

function resolveBase(argv) {
  const index = argv.indexOf("--base");
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
}

/**
 * `git diff --numstat -z --no-renames` output: one `added\tdeleted\tpath`
 * record per NUL. Without `-z`, git quotes and escapes unusual paths, which
 * would hide them from `isMeasuredFile`.
 *
 * A source file git reports as binary ("-" counts, for example under a `-diff`
 * attribute) goes in `uncounted`, for `measureDiff` to count from its patch.
 */
export function parseNumstat(output) {
  const files = [];
  const uncounted = [];
  for (const record of output.split("\0")) {
    // A path may itself contain tabs: only the first two separate fields.
    const [added, deleted, ...rest] = record.split("\t");
    const path = rest.join("\t");
    if (!path || !isMeasuredFile(path)) continue;
    if (added === "-") uncounted.push(path);
    else files.push({ path, lines: Number(added) + Number(deleted) });
  }
  return { files, uncounted };
}

/** Changed lines in a `git diff -U0` patch, counted only inside hunks. */
export function countPatchLines(patch) {
  let inHunk = false;
  let lines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff --git")) inHunk = false;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-")))
      lines += 1;
  }
  return lines;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function measureDiff(base) {
  const { files, uncounted } = parseNumstat(
    git(["diff", "--numstat", "-z", "--no-renames", base, "HEAD"])
  );
  // `--text` makes the patch show what numstat would not count.
  for (const path of uncounted) {
    const patch = git([
      "diff",
      "--text",
      "-U0",
      "--no-renames",
      base,
      "HEAD",
      "--",
      path,
    ]);
    files.push({ path, lines: countPatchLines(patch) });
  }
  files.sort((a, b) => b.lines - a.lines);
  const total = files.reduce((sum, file) => sum + file.lines, 0);
  return { total, files };
}

export function verdict(total, labels) {
  if (total > LIMIT && !labels.includes("mechanical")) return "fail";
  if (total > LARGE)
    return labels.includes("large-pr") || labels.includes("mechanical")
      ? "large-labelled"
      : "large";
  return "ok";
}

function report({ total, files }, labels) {
  const result = verdict(total, labels);
  const lines = [
    "## PR size",
    "",
    `**${total}** changed lines of hand-written source (budget ${LARGE}, hard limit ${LIMIT}).`,
    "",
  ];
  if (result === "fail") {
    lines.push(
      `Over ${LIMIT}. Split it into stacked PRs, or, if it is a move or codemod, label it \`mechanical\` and review it with \`git diff --color-moved\`.`
    );
  } else if (result === "large") {
    lines.push(
      `Over ${LARGE}. Label it \`large-pr\`; it needs two human approvals.`
    );
  } else if (result === "large-labelled") {
    lines.push(`Over ${LARGE} and labelled.`);
  } else {
    lines.push("Within budget.");
  }
  if (files.length) {
    lines.push("", "| File | Lines |", "|---|---|");
    for (const file of files.slice(0, 15)) {
      lines.push(`| \`${file.path}\` | ${file.lines} |`);
    }
    if (files.length > 15) lines.push(`| ${files.length - 15} more | |`);
  }
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  return result === "fail" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const labels = (process.env.PR_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  process.exitCode = report(
    measureDiff(resolveBase(process.argv.slice(2))),
    labels
  );
}
