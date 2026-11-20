import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  countErrors,
  failedWithoutDiagnostics,
  globalErrors,
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

test("CRLF output (tsc on Windows) counts the same as LF", () => {
  assert.deepEqual(countErrors(OUTPUT.replaceAll("\n", "\r\n")), {
    "server/a.ts": 2,
    "server/b.ts": 1,
  });
});

test("backslash paths count under the forward-slash baseline key", () => {
  const output = [
    "server\\a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    "server\\__tests__\\c.test.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\r\n");
  assert.deepEqual(countErrors(output), { "server/a.ts": 1 });
});

test("a failing tsc with nothing parseable is flagged, not read as zero errors", () => {
  assert.equal(failedWithoutDiagnostics(2, ""), true);
  assert.equal(failedWithoutDiagnostics(null, ""), true);
  assert.equal(
    failedWithoutDiagnostics(
      2,
      "server/a.ts:1:1 - error TS2322: unexpected format",
    ),
    true,
  );
  assert.equal(failedWithoutDiagnostics(2, OUTPUT), false);
  assert.equal(
    failedWithoutDiagnostics(
      2,
      "client/x.ts(1,1): error TS2322: outside server\r\n",
    ),
    false,
  );
  assert.equal(
    failedWithoutDiagnostics(
      1,
      "error TS5058: The specified path does not exist.\r\n",
    ),
    false,
  );
  assert.equal(failedWithoutDiagnostics(0, ""), false);
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
  assert.deepEqual(globalErrors(output.replaceAll("\n", "\r\n")), [
    "error TS5058: The specified path does not exist: 'nope.json'.",
  ]);
});
