/**
 * The local runner's case conversion agrees with what `cloud eval run --file`
 * sends, field by field.
 *
 * `platformCaseFromSuiteFileCase` (SDK) is how a suite-file case reaches the
 * shared corpus conversion locally; `fileCaseToCreateBody` (CLI) is how the
 * same case reaches the hosted API. After normalizing the wire-only
 * differences — the count's floor/exact key pair, the hosted-only timestamp
 * and declared-id fields, and "omitted when false" for `isNegative` — the two
 * must say the same thing about every case, or a local pass would describe a
 * different case than the hosted run grades.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadEvalSuiteFile, platformCaseFromSuiteFileCase } from "@mcpjam/sdk";
import { fileCaseToCreateBody } from "../src/lib/eval-run-file.js";

const SUITE = `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_conversion
  name: conversion
target:
  servers:
    - name: notes
defaults:
  judge:
    enabled: true
    role: advisory
  model: anthropic/claude-haiku-4.5
  provider: anthropic
  iterations: 3
  passThreshold: 0.6
  validity: {}
provenance:
  sourceHash: sha256:abc
  sourceFormat: promptfoo
  reportHash: sha256:def
cases:
  - id: c_full
    title: everything set
    intent: lookup
    kind: regression
    model: openai/gpt-5.4-mini
    iterations: 2
    passThreshold: 1
    isNegativeTest: false
    expectedOutput: the note says buy milk
    judge:
      enabled: false
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: read_note
          args: { args: { id: "7" } }
    assertions:
      - type: responseContains
        needle: milk
    suppressedSuiteStandardCheckIds: []
    import:
      status: approximated
      sourceCaseKey: tests[0]
      note: rubric became a needle
  - id: c_minimal
    title: defaults only
    isNegativeTest: true
    steps:
      - id: s1
        kind: prompt
        prompt: Do nothing
`;

function normalizedHosted(
  body: Record<string, unknown>
): Record<string, unknown> {
  const {
    runs: _floor,
    repetitions: _exact,
    checks,
    ...rest
  } = body as Record<string, unknown> & {
    runs?: unknown;
    repetitions?: unknown;
  };
  return {
    ...rest,
    isNegative: body.isNegative === true,
    // The hosted body spells the configured count twice (floor and exact);
    // both carry the file's one count.
    iterations: body.repetitions,
    ...(checks !== undefined ? { checks } : {}),
  };
}

function normalizedLocal(
  body: Record<string, unknown>
): Record<string, unknown> {
  const { createdAt: _c, updatedAt: _u, declaredId, ...rest } = body;
  assert.equal(declaredId, body.id, "the authored id is the declared identity");
  return rest;
}

test("every resolved field maps the same way locally and hosted", () => {
  const loaded = loadEvalSuiteFile(SUITE);
  assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.findings));
  for (const testCase of loaded.resolved.cases) {
    const local = normalizedLocal(
      platformCaseFromSuiteFileCase(testCase) as unknown as Record<
        string,
        unknown
      >
    );
    const hosted = normalizedHosted(fileCaseToCreateBody(testCase, 1));
    assert.deepEqual(local, hosted, testCase.id);
  }
});

test("resolved defaults are carried, never re-derived", () => {
  const loaded = loadEvalSuiteFile(SUITE);
  assert.ok(loaded.ok);
  const minimal = platformCaseFromSuiteFileCase(loaded.resolved.cases[1]!);
  assert.equal(minimal.iterations, 3);
  assert.equal(minimal.passThreshold, 0.6);
  assert.deepEqual(minimal.models, [
    { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
  ]);
  assert.equal(minimal.isNegative, true);
  // Absent stays absent: no empty rule override, no judge, no import claim.
  assert.equal("checks" in minimal, false);
  assert.equal("judge" in minimal, false);
  assert.equal("import" in minimal, false);
});
