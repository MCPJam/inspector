import { describe, expect, test } from "vitest";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import { buildHostedScoreContract } from "../../score-rows.js";
import { parseHarnessOutput, prepareSource } from "../harness.js";
import { createLocalCodeEvaluatorRunner } from "../local-runner.js";
import { createCodeEvaluatorRunner } from "../runner-registry.js";
import {
  codeEvaluatorsFailTrial,
  NO_CODE_RUNNER_REASON,
  runTrialCodeEvaluators,
} from "../run-iteration.js";
import type { CodeEvaluatorDefinition } from "../types.js";

const sums: CodeEvaluatorDefinition = {
  id: "states-the-sum",
  label: "States the sum",
  role: "required",
  source: `
type Run = { finalAssistantMessage?: string };
export function evaluate(run: Run) {
  console.log("checking", run.finalAssistantMessage);
  const ok = (run.finalAssistantMessage ?? "").includes("42");
  return { pass: ok, reason: ok ? "says 42" : "no 42 in the answer" };
}`,
};

describe("harness output", () => {
  test("scores a well-formed result and keeps the logs", () => {
    expect(
      parseHarnessOutput('hello\n@@MCPJAM_CODE_RESULT@@{"value":{"pass":true,"score":0.5,"reason":"ok"}}\n'),
    ).toEqual({ status: "scored", pass: true, score: 0.5, reason: "ok", logs: "hello" });
  });

  test("a throw, a bad shape or no result is an error, never a fail", () => {
    expect(parseHarnessOutput('@@MCPJAM_CODE_RESULT@@{"error":"Error: boom"}')).toMatchObject({
      status: "error",
      reason: expect.stringContaining("evaluate() threw: Error: boom"),
    });
    expect(parseHarnessOutput('@@MCPJAM_CODE_RESULT@@{"value":{"ok":true}}')).toMatchObject({
      status: "error",
      reason: expect.stringContaining("expected { pass, reason }"),
    });
    expect(parseHarnessOutput('@@MCPJAM_CODE_RESULT@@{"value":{"pass":true,"reason":"x","score":2}}')).toMatchObject({
      status: "error",
    });
    expect(parseHarnessOutput("just logs")).toMatchObject({ status: "error" });
  });

  test("types are stripped; non-erasable syntax is a clear error", () => {
    expect(prepareSource("const a: number = 1;").ok).toBe(true);
    const bad = prepareSource("enum Color { Red }");
    expect(bad.ok).toBe(false);
  });
});

describe("the local test runner", () => {
  const runner = createLocalCodeEvaluatorRunner();
  const run = (source: string, runData: unknown) => {
    const prepared = prepareSource(source);
    if (!prepared.ok) throw new Error(prepared.reason);
    return runner.run({ module: prepared.module, runJson: JSON.stringify(runData) });
  };

  test("runs TypeScript against the run data", async () => {
    await expect(run(sums.source, { finalAssistantMessage: "The sum is 42." })).resolves.toEqual({
      status: "scored",
      pass: true,
      reason: "says 42",
      logs: "checking The sum is 42.",
    });
  });

  test("reports a missing evaluate export and a throw as errors", async () => {
    await expect(run("export const x = 1;", {})).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("does not export a function named evaluate"),
    });
    await expect(
      run("export function evaluate() { throw new Error('nope'); }", {}),
    ).resolves.toMatchObject({ status: "error", reason: expect.stringContaining("nope") });
  });

  test("passes the child no environment", async () => {
    await expect(
      run("export function evaluate() { return { pass: !process.env.PATH && !process.env.HOME, reason: 'env' }; }", {}),
    ).resolves.toMatchObject({ status: "scored", pass: true });
  });
});

describe("runner selection", () => {
  test("E2B with a key, local only outside production when asked, else none", () => {
    expect(createCodeEvaluatorRunner({ E2B_API_KEY: "k" })?.kind).toBe("e2b");
    expect(createCodeEvaluatorRunner({ MCPJAM_CODE_EVALUATOR_RUNNER: "local" })?.kind).toBe("local");
    expect(
      createCodeEvaluatorRunner({ MCPJAM_CODE_EVALUATOR_RUNNER: "local", NODE_ENV: "production" }),
    ).toBeNull();
    expect(createCodeEvaluatorRunner({})).toBeNull();
  });
});

describe("a trial's code evaluators", () => {
  test("without a runner each one is an error, and none fails the trial", async () => {
    const outcomes = await runTrialCodeEvaluators({
      evaluators: [sums],
      run: {},
      runKey: "r",
      runner: null,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ id: "states-the-sum", status: "error", reason: NO_CODE_RUNNER_REASON }),
    ]);
    expect(codeEvaluatorsFailTrial(outcomes)).toBe(false);
  });

  test("a Required fail fails the trial; an Advisory fail does not", async () => {
    const outcomes = await runTrialCodeEvaluators({
      evaluators: [sums, { ...sums, id: "advisory-copy", role: "advisory" }],
      run: { finalAssistantMessage: "no idea" },
      runKey: "r",
      runner: createLocalCodeEvaluatorRunner(),
    });
    expect(outcomes.map((o) => o.status === "scored" && o.pass)).toEqual([false, false]);
    expect(codeEvaluatorsFailTrial(outcomes)).toBe(true);
    expect(codeEvaluatorsFailTrial(outcomes.slice(1))).toBe(false);
  });
});

describe("score rows", () => {
  const outcome = {
    id: "states-the-sum",
    label: "States the sum",
    role: "required" as const,
    sourceDigest: "d1",
  };

  test("a Required fail is a gating code:<id> row that fails the gate", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      codeEvaluatorResults: [{ ...outcome, status: "scored", pass: false, reason: "no 42" }],
    });
    expect(scores[0]).toMatchObject({ scorerId: "code:states-the-sum", value: 0, passed: false });
    expect(evaluationConfig.definitions[0]).toMatchObject({ deterministic: true, role: "gating" });
    expect(allGatingScorersPassed(scores, evaluationConfig).passed).toBe(false);
  });

  test("an error row has no value; a new source digest is a new definition", () => {
    const errored = buildHostedScoreContract({
      codeEvaluatorResults: [{ ...outcome, status: "error", reason: "Stopped after 10 seconds." }],
    });
    expect(errored.scores[0]).toMatchObject({ status: "error" });
    expect(errored.scores[0]).not.toHaveProperty("value");
    const edited = buildHostedScoreContract({
      codeEvaluatorResults: [{ ...outcome, sourceDigest: "d2", status: "error", reason: "x" }],
    });
    expect(edited.evaluationConfig.definitions[0].implementationHash).not.toBe(
      errored.evaluationConfig.definitions[0].implementationHash,
    );
  });
});
