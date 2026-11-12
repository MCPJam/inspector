import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  countErrors,
  globalErrors,
  tscFailure,
} from "../typecheck-server.mjs";

const OUTPUT = [
  "server/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  "server/a.ts(2,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
  "server/b.ts(3,1): error TS2307: Cannot find module '../Thing.bundled.js' or its corresponding type declarations.",
  "server/b.ts(4,1): error TS2307: Cannot find module 'hono' or its corresponding type declarations.",
  "server/__tests__/c.test.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  "server/test/support/mock.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  "client/src/lib/x.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  "../sdk/src/y.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  continuation line of a long message",
].join("\n");

test("counts server source errors per file, skipping tests and generated modules", () => {
  assert.deepEqual(countErrors(OUTPUT), { "server/a.ts": 2, "server/b.ts": 1 });
});

test("a file over its allowance regresses; under it improves", () => {
  const { regressions, improvements } = compare(
    { "server/a.ts": 2, "server/b.ts": 3 },
    { "server/a.ts": 3, "server/b.ts": 1, "server/new.ts": 1 },
  );
  assert.deepEqual(
    regressions.map((r) => r.file),
    ["server/a.ts", "server/new.ts"],
  );
  assert.deepEqual(
    improvements.map((r) => r.file),
    ["server/b.ts"],
  );
});

test("project-level errors are reported, not read as zero file errors", () => {
  const output =
    "error TS5058: The specified path does not exist: 'nope.json'.\n" + OUTPUT;
  assert.deepEqual(globalErrors(output), [
    "error TS5058: The specified path does not exist: 'nope.json'.",
  ]);
  assert.deepEqual(globalErrors(OUTPUT), []);
});

test("a tsc that crashed or reported nothing fails instead of counting zero", () => {
  // Through npx, running out of memory is exit 134 with nothing on stdout.
  const oom = tscFailure({
    status: 134,
    signal: null,
    stdout: "",
    stderr:
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
  });
  assert.match(oom, /exited with status 134 without reporting a diagnostic/);
  assert.match(oom, /NODE_OPTIONS=--max-old-space-size=8192/);
  // Killed mid-run (or past maxBuffer): partial stdout is not a result.
  assert.match(
    tscFailure({ status: null, signal: "SIGTERM", stdout: OUTPUT, stderr: "" }),
    /was killed by SIGTERM/,
  );
  // npx failing to start tsc also exits 1, with nothing on stdout.
  assert.match(
    tscFailure({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "npm error could not determine executable to run\n",
    }),
    /status 1 without reporting a diagnostic.*stderr is above/,
  );
});

test("a tsc that reported diagnostics is the result, project-level ones included", () => {
  assert.equal(
    tscFailure({ status: 2, signal: null, stdout: OUTPUT, stderr: "" }),
    null,
  );
  assert.equal(
    tscFailure({
      status: 3,
      signal: null,
      stdout: "error TS5058: The specified path does not exist: 'nope.json'.\n",
      stderr: "",
    }),
    null,
  );
});
