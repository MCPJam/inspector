#!/usr/bin/env node
/**
 * The slop scorecard: every rule in `rules.mjs`, counted across tracked,
 * hand-written source and grouped by package.
 *
 *   node scripts/slop/measure.mjs          # table
 *   node scripts/slop/measure.mjs --json   # { totals, packages, files }
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { RULES, countFile, isMeasuredFile } from "./rules.mjs";

/** `mcpjam-inspector/server/...` → `mcpjam-inspector/server`; `sdk/...` → `sdk`. */
export function packageOf(path) {
  const [first, second] = path.split("/");
  if (
    first === "mcpjam-inspector" &&
    ["client", "server", "shared"].includes(second)
  ) {
    return `${first}/${second}`;
  }
  return path.includes("/") ? first : "(root)";
}

function emptyCounts() {
  return Object.fromEntries(RULES.map((rule) => [rule.id, 0]));
}

export function measure(cwd = process.cwd()) {
  const paths = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path && isMeasuredFile(path));

  const totals = emptyCounts();
  const packages = {};
  const files = {};
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(`${cwd}/${path}`, "utf8");
    } catch {
      // Listed by git but deleted in the working tree: nothing to count.
      continue;
    }
    const counts = countFile(path, text);
    const pkg = (packages[packageOf(path)] ??= emptyCounts());
    let any = false;
    for (const [id, n] of Object.entries(counts)) {
      totals[id] += n;
      pkg[id] += n;
      if (n) any = true;
    }
    if (any) files[path] = counts;
  }
  return { fileCount: paths.length, totals, packages, files };
}

function printTable({ fileCount, totals, packages }) {
  const ids = RULES.map((rule) => rule.id);
  const names = Object.keys(packages).sort();
  const width = Math.max(10, ...names.map((name) => name.length));
  const header = ["package".padEnd(width), ...ids].join("  ");
  console.log(`Slop scorecard over ${fileCount} source files\n`);
  console.log(header);
  for (const name of names) {
    const row = ids.map((id) => String(packages[name][id]).padStart(id.length));
    console.log([name.padEnd(width), ...row].join("  "));
  }
  const total = ids.map((id) => String(totals[id]).padStart(id.length));
  console.log(["TOTAL".padEnd(width), ...total].join("  "));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = measure();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result);
  }
}
