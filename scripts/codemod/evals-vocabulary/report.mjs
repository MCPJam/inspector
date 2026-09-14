/**
 * Regenerate REPORT.md without losing the scanner's verdict.
 *
 * The npm script used to redirect the scanner into a temp file and chain
 * `&& mv … || (rm … && exit 1)`. That fallback hard-coded `exit 1`, so a
 * refusal (exit 2: the mapping proposes to mutate a protected term, or to merge
 * two fields) reached a caller of the documented command as exit 1, the code
 * for "scanned nothing". Exit 2 is the one a caller most needs to see.
 *
 * So this wrapper runs the scanner, writes the report only on a clean run, and
 * exits with the scanner's own status. Plain Node, so every shell npm might
 * pick behaves the same.
 *
 *   node scripts/codemod/evals-vocabulary/report.mjs [--out <path>] [scanner flags]
 */

import { spawnSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--json")) {
  console.error(
    "report.mjs writes the markdown report; run index.mjs directly for --json."
  );
  process.exit(1);
}

const outIndex = args.indexOf("--out");
if (outIndex >= 0 && !args[outIndex + 1]) {
  console.error("--out needs a path.");
  process.exit(1);
}
const out =
  outIndex >= 0 ? resolve(args[outIndex + 1]) : join(here, "REPORT.md");
const forwarded =
  outIndex >= 0
    ? [...args.slice(0, outIndex), ...args.slice(outIndex + 2)]
    : args;

const result = spawnSync(
  process.execPath,
  [join(here, "index.mjs"), ...forwarded],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 512 * 1024 * 1024,
  }
);

if (result.error) {
  console.error(String(result.error));
  process.exit(1);
}

// A scanner killed by a signal has no status, and has not reported cleanly.
const status = result.status ?? 1;
if (status !== 0) process.exit(status);

const tmp = `${out}.tmp`;
try {
  writeFileSync(tmp, result.stdout);
  renameSync(tmp, out);
} catch (error) {
  rmSync(tmp, { force: true });
  console.error(String(error));
  process.exit(1);
}
