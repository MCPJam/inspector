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
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/**
 * tsc ends lines with CRLF on Windows, which the `$` in ERROR_LINE would never
 * match, and the baseline keys use `/` whatever the platform.
 */
function outputLines(output) {
  return output.split(/\r?\n/);
}

/** Every located diagnostic tsc printed, in any file. */
function diagnostics(output) {
  const found = [];
  for (const line of outputLines(output)) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const [, file, code, message] = match;
    found.push({ file: file.replaceAll("\\", "/"), code, message });
  }
  return found;
}

export function countErrors(output) {
  const counts = {};
  for (const { file, code, message } of diagnostics(output)) {
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
  execFileSync(
    process.execPath,
    [join(INSPECTOR, "scripts", "build-sdk-if-stale.mjs")],
    {
      cwd: INSPECTOR,
      // Quiet unless it fails; execFileSync then throws with the build's stderr.
      stdio: "pipe",
    },
  );
}

/**
 * Telemetry catalogs are JSON imports the server type-checks against. A
 * missing one would resolve to `any` and quietly hide errors from the
 * ratchet, so write them first; a changed SDK catalog then makes
 * `ensureSdkBuilt` rebuild.
 */
function writeTelemetryCatalogs() {
  execFileSync(
    process.execPath,
    [join(INSPECTOR, "..", "scripts", "generate-telemetry-catalogs.mjs")],
    {
      cwd: INSPECTOR,
      stdio: "pipe",
    },
  );
}

/**
 * Runs tsc's JS entry with this Node rather than through `npx`: on Windows
 * `npx` is a `.cmd` shim that cannot be spawned without a shell. Resolved from
 * the inspector package, as `npx tsc` would.
 */
function runTsc() {
  const tsc = createRequire(join(INSPECTOR, "package.json")).resolve(
    "typescript/bin/tsc",
  );
  const result = spawnSync(
    process.execPath,
    [tsc, "--noEmit", "--pretty", "false", "-p", "server/tsconfig.json"],
    { cwd: INSPECTOR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  // tsc exits non-zero whenever it reports errors; the output is the result.
  return {
    output: result.stdout,
    status: result.status,
    signal: result.signal,
    stderr: result.stderr,
  };
}

/** Project-level errors that would otherwise read as "no file has errors". */
export function globalErrors(output) {
  return outputLines(output).filter((line) => GLOBAL_ERROR.test(line));
}

/**
 * tsc's `ExitStatus` values for a run that checked the whole program:
 * Success, DiagnosticsPresent_OutputsSkipped, DiagnosticsPresent_OutputsGenerated.
 */
const COMPLETED_STATUSES = new Set([0, 1, 2]);

/**
 * Why tsc's result cannot be counted, or null when it can. A killed or crashed
 * tsc may have printed only some of its diagnostics, so any other status is
 * fatal whatever the output. A completed failing run with nothing this script
 * can read (an output format the parser does not match) is fatal too.
 * Counting either would pass the check and shrink the baseline on `--update`.
 */
export function unusableResult({ status, signal, output }) {
  if (!COMPLETED_STATUSES.has(status)) {
    return signal
      ? `tsc was terminated by ${signal} before it finished:`
      : `tsc exited with unexpected status ${status}:`;
  }
  if (
    status !== 0 &&
    diagnostics(output).length === 0 &&
    globalErrors(output).length === 0
  ) {
    return `tsc exited with status ${status} but printed no diagnostics this script can parse:`;
  }
  return null;
}

function total(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, and a space in the
// checkout path is percent-encoded only in the URL.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeTelemetryCatalogs();
  ensureSdkBuilt();
  const { output, status, signal, stderr } = runTsc();
  const unusable = unusableResult({ status, signal, output });
  if (unusable) {
    console.error(unusable);
    console.error(`${output}${stderr}`.trim() || "  (no output)");
    process.exit(1);
  }
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
