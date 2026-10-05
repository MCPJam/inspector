import assert from "node:assert/strict";
import test from "node:test";
import {
  caseWarningsOf,
  formatCaseWarnings,
  withCaseWarningsOnStderr,
} from "../src/lib/eval-case-warnings.js";

const vacuousWarning = {
  code: "case_passes_with_empty_answer",
  message:
    "This case passes even when the agent does nothing, so it cannot catch an agent that skips the task. Add an expected tool call or a check an empty answer fails (for example a response check).",
};

function fakeOp(result: unknown) {
  return {
    name: "create_eval_case",
    title: "Create",
    description: "",
    readOnly: false,
    inputSchema: {} as any,
    permalink: {} as any,
    execute: async () => result,
  } as any;
}

test("reads well-formed warnings off a case response", () => {
  assert.deepEqual(
    caseWarningsOf({ id: "c1", warnings: [vacuousWarning, { code: 1 }] }),
    [vacuousWarning],
  );
  assert.deepEqual(caseWarningsOf({ id: "c1" }), []);
  assert.deepEqual(caseWarningsOf(null), []);
});

test("formats one stderr line per warning", () => {
  assert.deepEqual(formatCaseWarnings({ warnings: [vacuousWarning] }), [
    `warning: ${vacuousWarning.message} (case_passes_with_empty_answer)`,
  ]);
});

test("human output prints warnings to stderr and returns the result untouched", async () => {
  const written: string[] = [];
  const result = { id: "c1", warnings: [vacuousWarning] };
  const op = withCaseWarningsOnStderr(fakeOp(result), "human", {
    write: (chunk: string) => written.push(chunk),
  });
  assert.equal(await op.execute({}, {} as any), result);
  assert.deepEqual(written, [
    `warning: ${vacuousWarning.message} (case_passes_with_empty_answer)\n`,
  ]);
});

test("JSON output leaves warnings in the result and writes nothing extra", async () => {
  const written: string[] = [];
  const result = { id: "c1", warnings: [vacuousWarning] };
  const original = fakeOp(result);
  const op = withCaseWarningsOnStderr(original, "json", {
    write: (chunk: string) => written.push(chunk),
  });
  assert.equal(op, original);
  const out = (await op.execute({}, {} as any)) as typeof result;
  assert.deepEqual(out.warnings, [vacuousWarning]);
  assert.deepEqual(written, []);
});
