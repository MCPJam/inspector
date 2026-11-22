import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  countErrors,
  globalErrors,
  unusableResult,
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
  const unusable = (status, output) => unusableResult({ status, output });
  assert.notEqual(unusable(2, ""), null);
  assert.notEqual(
    unusable(2, "server/a.ts:1:1 - error TS2322: unexpected format"),
    null,
  );
  assert.equal(
    unusable(2, "client/x.ts(1,1): error TS2322: outside server\r\n"),
    null,
  );
  assert.equal(
    unusable(1, "error TS5058: The specified path does not exist.\r\n"),
    null,
  );
  assert.equal(unusable(0, ""), null);
});

test("a completed run with diagnostics is counted", () => {
  for (const status of [1, 2]) {
    assert.equal(
      unusableResult({ status, signal: null, output: OUTPUT }),
      null,
    );
  }
});

test("a tsc that did not run to completion is fatal whatever it printed", () => {
  const oneDiagnostic =
    "server/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  assert.match(
    unusableResult({ status: null, signal: "SIGTERM", output: oneDiagnostic }),
    /terminated by SIGTERM/,
  );
  assert.match(
    unusableResult({ status: null, signal: null, output: oneDiagnostic }),
    /unexpected status null/,
  );
  assert.match(
    unusableResult({ status: 3, output: oneDiagnostic }),
    /unexpected status 3/,
  );
  assert.match(
    unusableResult({ status: 134, output: OUTPUT }),
    /unexpected status 134/,
  );
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
