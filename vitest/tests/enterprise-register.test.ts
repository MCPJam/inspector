import { afterAll, expect, it, vi } from "vitest";
import { EvalSuite, EvalTest, assertion } from "@mcpjam/sdk";
import { describeEvalSuite, testEval, runAndAssertCase } from "../src/index.js";
import { StubExecutor } from "./support/stub-executor.js";

const dispose = vi.fn();
const execute = vi.fn(async (executor) => {
  await executor.run("hello");
});
const skippedExecute = vi.fn();
const factory = vi.fn(() => new StubExecutor({ text: "ok" }));
const suite = new EvalSuite({
  name: "canonical suite",
  defaults: {
    iterations: 1,
    evaluators: [assertion({ type: "noToolErrors" })],
  },
});
suite.add(new EvalTest({ id: "selected", name: "selected case", execute }));
suite.add(
  new EvalTest({
    id: "skipped",
    name: "skipped case",
    execute: skippedExecute,
  }),
);
describeEvalSuite("canonical filtered suite", suite, {
  factory,
  dispose,
  run: { mcpjam: { enabled: false } },
  skip: ["skipped"],
  summary: "none",
  gate: { minimumPassRate: 1, selectionScope: "selected" },
});

const skipFactory = vi.fn(() => {
  throw new Error("Skipped factory must never run");
});
testEval.skip(
  new EvalTest({
    id: "skip-single",
    name: "skipped standalone",
    execute: () => {},
  }),
  {
    factory: skipFactory,
    run: { iterations: 1, mcpjam: { enabled: false } },
  },
);
describeEvalSuite.skip("skipped suite", suite, {
  factory: skipFactory,
  run: { iterations: 1, mcpjam: { enabled: false } },
});

afterAll(() => {
  expect(execute).toHaveBeenCalledTimes(1);
  expect(skippedExecute).not.toHaveBeenCalled();
  expect(factory).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(skipFactory).not.toHaveBeenCalled();
});

it("refuses unknown selection identities before registration or execution", () => {
  expect(() =>
    describeEvalSuite("unknown", suite, {
      factory,
      run: { iterations: 1 },
      only: ["missing"],
    }),
  ).toThrow(/Unknown selected case ID/);
});
it("does not certify an empty local run", () => {
  expect(() =>
    runAndAssertCase({ iterations: 0, failures: 0 } as any, "empty"),
  ).toThrow(/No iterations/);
});
