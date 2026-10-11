#!/usr/bin/env node
/**
 * The slop ratchet: fail when a change adds more of a rule than it removes.
 *
 * It compares each changed source file at `--base` with the working tree and
 * sums the difference per rule. Summing over the whole change, not per file,
 * keeps moves and splits neutral: code that leaves one file and lands in
 * another nets to zero. Comparing against the base commit, rather than a
 * committed baseline file, means two PRs that each pass cannot drift a
 * baseline out of date when both merge.
 *
 *   node scripts/slop/ratchet.mjs                 # vs merge-base with origin/main
 *   node scripts/slop/ratchet.mjs --base HEAD^1   # CI: the PR merge commit's base
 *
 * --ignore-untracked FILE skips the untracked paths listed in FILE, one per
 * line, and --tracked-only skips untracked files altogether. The Stop hook
 * uses them so untracked files that were already there when the turn began,
 * such as a person's scratch work, are not reported as the agent's change.
 *
 * SLOP_WAIVER=true reports the same result and exits 0. CI sets it from the
 * `slop-waiver` label, which a CODEOWNER applies with a reason in the PR.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RULES, countFile, isMeasuredFile } from "./rules.mjs";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readPathList(file) {
  if (!file) return undefined;
  return new Set(readFileSync(file, "utf8").split("\n").filter(Boolean));
}

function resolveBase(argv) {
  const index = argv.indexOf("--base");
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return git(["merge-base", "HEAD", "origin/main"]).trim();
}

function changedPaths(base, { trackedOnly = false, ignoreUntracked } = {}) {
  const tracked = git(["diff", "--name-only", "--no-renames", "-z", base])
    .split("\0")
    .filter(Boolean);
  const untracked = trackedOnly
    ? []
    : git(["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter((path) => path && !ignoreUntracked?.has(path));
  return [...new Set([...tracked, ...untracked])].filter(isMeasuredFile);
}

function readAtBase(base, path) {
  try {
    return git(["show", `${base}:${path}`]);
  } catch {
    // Added since the base: it had nothing to count.
    return "";
  }
}

export function compare(base, options) {
  const deltas = Object.fromEntries(RULES.map((rule) => [rule.id, 0]));
  const increases = [];
  for (const path of changedPaths(base, options)) {
    const before = countFile(path, readAtBase(base, path));
    const after = existsSync(path)
      ? countFile(path, readFileSync(path, "utf8"))
      : countFile(path, "");
    for (const rule of RULES) {
      const delta = after[rule.id] - before[rule.id];
      deltas[rule.id] += delta;
      if (delta > 0) increases.push({ path, rule: rule.id, delta });
    }
  }
  return { deltas, increases };
}

function report({ deltas, increases }, waived) {
  const failing = RULES.filter((rule) => deltas[rule.id] > 0);
  const lines = ["## Slop ratchet", ""];
  lines.push("| Rule | Net change |", "|---|---|");
  for (const rule of RULES) {
    const delta = deltas[rule.id];
    const shown = delta > 0 ? `**+${delta}**` : String(delta);
    lines.push(`| ${rule.label} | ${shown} |`);
  }
  if (failing.length) {
    lines.push("", "Files that added to a rising rule:", "");
    for (const { path, rule, delta } of increases) {
      if (deltas[rule] > 0) lines.push(`- \`${path}\`: ${rule} +${delta}`);
    }
    lines.push(
      "",
      waived
        ? "Waived by the `slop-waiver` label."
        : "Remove the additions, or remove as many elsewhere in the same change. A CODEOWNER can apply `slop-waiver` with a reason.",
    );
  } else {
    lines.push("", "No rule went up.");
  }
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  return failing.length > 0 && !waived ? 1 : 0;
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, not a `file:` URL.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = resolveBase(process.argv.slice(2));
  const waived = process.env.SLOP_WAIVER === "true";
  process.exitCode = report(
    compare(base, {
      trackedOnly: process.argv.includes("--tracked-only"),
      ignoreUntracked: readPathList(argValue("--ignore-untracked")),
    }),
    waived,
  );
}
