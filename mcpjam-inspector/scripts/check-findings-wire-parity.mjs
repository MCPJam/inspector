#!/usr/bin/env node
/**
 * Compare this repo's wire-parity fixture with the backend's copy.
 *
 * It NEVER prints "skipping" and passes. The backend checkout is not part of
 * this repository, so its location has to be supplied — and when it is not
 * supplied or does not exist, this exits NON-ZERO saying so, because "we could
 * not check" and "it matches" are different answers and only one of them is a
 * green tick.
 *
 *   npm run check:findings-wire-parity -w @mcpjam/inspector -- --backend ../mcpjam-backend
 *
 * Regenerate the backend copy with, in that checkout:
 *   WRITE_WIRE_FIXTURE=1 npx vitest run tests/convex/evalFindingsWireParity.test.ts
 * then copy it here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OURS = resolve(
  here,
  "../client/src/components/shared/actionable-insights/__tests__/fixtures/wire-parity-envelope.json",
);
const RELATIVE_BACKEND_PATH =
  "tests/fixtures/eval-findings-wire/wire-parity-envelope.json";

function fail(message) {
  console.error(`check:findings-wire-parity: ${message}`);
  process.exit(1);
}

// STRICT. A mirror check that shrugs at `--backed` and then compares against
// the default checkout reports a pass about a directory nobody asked for,
// which is the failure mode this script exists to prevent.
const argv = process.argv.slice(2);
let backend = process.env.MCPJAM_BACKEND_DIR ?? "../mcpjam-backend";
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== "--backend") {
    fail(`unknown argument "${argv[i]}". Usage: --backend <path>`);
  }
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    fail("--backend needs a path to the mcpjam-backend checkout");
  }
  backend = value;
  i += 1;
}

if (!existsSync(OURS)) {
  fail(`${OURS} is missing. This repo's copy of the fixture is the contract.`);
}

const theirs = resolve(process.cwd(), backend, RELATIVE_BACKEND_PATH);
if (!existsSync(theirs)) {
  fail(
    [
      `could not read the backend's fixture at ${theirs}.`,
      "",
      "Pass --backend <path to the mcpjam-backend checkout>, or set",
      "MCPJAM_BACKEND_DIR. This check does not pass when it cannot compare:",
      "an unverified wire contract is not a verified one.",
    ].join("\n"),
  );
}

const ours = readFileSync(OURS, "utf8");
const backendCopy = readFileSync(theirs, "utf8");
if (ours !== backendCopy) {
  fail(
    [
      "the two copies differ. The BACKEND is the producer, so copy its file here:",
      `  cp ${theirs} ${OURS}`,
      "",
      "…then re-run the client typecheck. If it fails, the backend is sending a",
      "field the SDK does not declare, which is the drift this check exists for.",
    ].join("\n"),
  );
}

console.log(
  `check:findings-wire-parity: the fixtures match (${ours.length} bytes).`,
);

for (const name of [
  "trace-report-envelope.json",
  "trace-report-iteration.json",
]) {
  const local = resolve(dirname(OURS), name);
  const remote = resolve(dirname(theirs), name);
  if (
    !existsSync(local) ||
    !existsSync(remote) ||
    readFileSync(local, "utf8") !== readFileSync(remote, "utf8")
  )
    fail(`the paired trace-report fixture differs or is missing: ${name}`);
}
