import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  countErrors,
  globalErrors,
  tscReport,
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

test("a tsc that reported errors is a result; one that stopped part way is not", () => {
  assert.equal(tscReport({ status: 2, signal: null, stdout: OUTPUT }), OUTPUT);
  assert.equal(tscReport({ status: 1, signal: null, stdout: "x" }), "x");
  // An out-of-memory abort leaves a short, partial report behind.
  assert.throws(
    () => tscReport({ status: 134, signal: null, stdout: OUTPUT }),
    /stopped before finishing \(exit 134\)/,
  );
  assert.throws(
    () => tscReport({ status: null, signal: "SIGABRT", stdout: OUTPUT }),
    /stopped before finishing \(SIGABRT\)/,
  );
  assert.throws(() => tscReport({ status: 2, signal: null }), /stopped/);
});
