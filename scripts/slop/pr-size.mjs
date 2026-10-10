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

export function measureDiff(base) {
  const numstat = execFileSync(
    "git",
    ["diff", "--numstat", "--no-renames", base, "HEAD"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  const files = [];
  for (const line of numstat.split("\n")) {
    const [added, deleted, path] = line.split("\t");
    // Binary files report "-" for both counts.
    if (!path || added === "-" || !isMeasuredFile(path)) continue;
    files.push({ path, lines: Number(added) + Number(deleted) });
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
