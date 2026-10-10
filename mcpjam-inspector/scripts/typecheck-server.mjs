#!/usr/bin/env node
/**
 * Server typecheck, as a ratchet. `tsc -p server/tsconfig.json` reports a few
 * hundred existing errors, so a plain pass/fail gate would be red from day
 * one. This counts errors per file in server source (tests excluded) and fails
 * when any file has more than `server/tsc-baseline.json` allows.
 *
 *   npm run typecheck:server -w @mcpjam/inspector             # check
 *   npm run typecheck:server -w @mcpjam/inspector -- --update # rewrite the baseline
 *
 * Errors about generated `*.bundled` / `*.generated` modules are ignored: they
 * exist only before the bundle scripts run, and the count must not depend on
 * whether they have.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSPECTOR = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = join(INSPECTOR, "server", "tsc-baseline.json");

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.tsx?$/;
const GENERATED_MODULE =
  /Cannot find module '[^']*\.(?:bundled|generated)(?:\.js)?'/;

export function countErrors(output) {
  const counts = {};
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const [, file, code, message] = match;
    if (TEST_FILE.test(file)) continue;
    if (code === "TS2307" && GENERATED_MODULE.test(message)) continue;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function compare(baseline, current) {
  const regressions = [];
  const improvements = [];
  for (const file of new Set([
    ...Object.keys(baseline),
    ...Object.keys(current),
  ])) {
    const allowed = baseline[file] ?? 0;
    const now = current[file] ?? 0;
    if (now > allowed) regressions.push({ file, allowed, now });
    else if (now < allowed) improvements.push({ file, allowed, now });
  }
  return { regressions, improvements };
}

function runTsc() {
  try {
    execFileSync(
      "npx",
      ["tsc", "--noEmit", "--pretty", "false", "-p", "server/tsconfig.json"],
      { cwd: INSPECTOR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    return "";
  } catch (error) {
    // tsc exits non-zero whenever it reports errors; the output is the result.
    if (typeof error.stdout !== "string") throw error;
    return error.stdout;
  }
}

function total(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const current = countErrors(runTsc());
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(
      `Wrote ${total(current)} errors in ${
        Object.keys(current).length
      } files to server/tsc-baseline.json`,
    );
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    const { regressions, improvements } = compare(baseline, current);
    console.log(
      `Server type errors: ${total(current)} (baseline ${total(baseline)})`,
    );
    for (const { file, allowed, now } of regressions) {
      console.log(`  more errors: ${file} ${allowed} -> ${now}`);
    }
    if (improvements.length) {
      console.log(
        `${improvements.length} file(s) improved. Lock it in with: npm run typecheck:server -w @mcpjam/inspector -- --update`,
      );
    }
    if (regressions.length) {
      console.log(
        "Fix the new errors, or run tsc -p server/tsconfig.json to see them.",
      );
      process.exitCode = 1;
    }
  }
}
