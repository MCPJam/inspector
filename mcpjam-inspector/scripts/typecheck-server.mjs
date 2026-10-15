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
import { fileURLToPath, pathToFileURL } from "node:url";

const INSPECTOR = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = join(INSPECTOR, "server", "tsc-baseline.json");

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;
/** A diagnostic with no file location: a broken config, not a code error. */
const GLOBAL_ERROR = /^error TS\d+:/;
/** The ratchet covers server source only, not what the server imports. */
const SERVER_SOURCE = /^server\//;
const TEST_FILE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures)\/|\.(?:test|spec)\.tsx?$/;
const GENERATED_MODULE =
  /Cannot find module '[^']*\.(?:bundled|generated)(?:\.js)?'/;

export function countErrors(output) {
  const counts = {};
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const [, file, code, message] = match;
    if (!SERVER_SOURCE.test(file) || TEST_FILE.test(file)) continue;
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

/**
 * Server files that import `@mcpjam/sdk` subpaths resolve them through the
 * package's `dist/`, so the error count depends on whether the SDK is built.
 * CI builds it before this step (`npm run typecheck`); building it here when
 * stale makes a local run count the same thing CI does.
 */
function ensureSdkBuilt() {
  execFileSync("node", [join(INSPECTOR, "scripts", "build-sdk-if-stale.mjs")], {
    cwd: INSPECTOR,
    // Quiet unless it fails; execFileSync then throws with the build's stderr.
    stdio: "pipe",
  });
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

/** Project-level errors that would otherwise read as "no file has errors". */
export function globalErrors(output) {
  return output.split("\n").filter((line) => GLOBAL_ERROR.test(line));
}

function total(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, and a space in the
// checkout path is percent-encoded only in the URL.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureSdkBuilt();
  const output = runTsc();
  const fatal = globalErrors(output);
  if (fatal.length) {
    console.error("tsc failed before checking any file:");
    for (const line of fatal) console.error(`  ${line}`);
    process.exit(1);
  }
  const current = countErrors(output);
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
