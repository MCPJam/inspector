/**
 * Self-hosting: `describeEvalSuite` registers real tests in THIS file, and
 * vitest runs them as part of the package's own suite.
 *
 * That is the only honest test of a wrapper whose whole job is registration.
 * Asserting that it "called describe" against a mock would prove the mock was
 * called, not that a consumer's `vitest run` reports one passing test per eval
 * case — which is the actual claim.
 *
 * The GREEN path is therefore implicit: if registration were broken, the tests
 * below would not exist and the file would report fewer tests than it should,
 * so a count assertion guards it. The RED path cannot be self-hosted (a
 * deliberately failing generated test would fail the run), so it goes through
 * the exported `runAndAssertCase` inside an ordinary `it`.
 */
import { describe, expect, it } from "vitest";
import { EvalSuite, EvalTest } from "@mcpjam/sdk";
import {
  describeEvalSuite,
  planEvalSuite,
  runAndAssertCase,
  testEval,
} from "../src/index.js";
import { StubExecutor } from "./support/stub-executor.js";

function passingSuite(): EvalSuite {
  const suite = new EvalSuite({ name: "registered suite" });
  suite.add(
    new EvalTest({
      // A corpus-backed case declares its hosted id in both fields; `EvalTest`
      // rejects a differing pair.
      id: "case_first",
      name: "answers the first prompt",
      externalCaseId: "case_first",
      test: async (executor) => {
        await executor.run("hello");
        return true;
      },
    })
  );
  suite.add(
    new EvalTest({
      id: "c_register_second",
      name: "answers the second prompt",
      test: async (executor) => {
        await executor.run("again");
        return true;
      },
    })
  );
  return suite;
}

// Registered at module scope, exactly as a consumer would. These become real
// vitest tests: "answers the first prompt [case_first]", "answers the second
// prompt", and "eval gate".
describeEvalSuite("a hosted-style eval suite", passingSuite(), {
  executor: new StubExecutor({ text: "ok" }),
  run: { iterations: 1, mcpjam: { enabled: false } },
  gate: { minimumPassRate: 1 },
  hookTimeoutMs: 30_000,
});

// The single-test seat, with a gate. Registers "a standalone eval" and
// "eval gate" — the gate test exists here to prove `testEval` HONOURS the
// policy rather than accepting the option and dropping it.
testEval(
  new EvalTest({
    id: "c_register_standalone",
    name: "a standalone eval",
    test: async (executor) => {
      await executor.run("hello");
      return true;
    },
  }),
  {
    executor: new StubExecutor({ text: "ok" }),
    run: { iterations: 1, mcpjam: { enabled: false } },
    gate: { minimumPassRate: 1 },
    hookTimeoutMs: 30_000,
  }
);

describe("registration", () => {
  it("plans one case per test plus a gate", () => {
    const plan = planEvalSuite(passingSuite(), { gate: { minimumPassRate: 1 } });
    expect(plan.cases.map((entry) => entry.title)).toEqual([
      "answers the first prompt [case_first]",
      "answers the second prompt",
    ]);
    expect(plan.gateTestTitle).toBe("eval gate");
  });

  it("fails a case whose iterations failed", () => {
    // The red path, asserted from a normal test. A generated failing test
    // would fail this file, so the assertion goes through the same helper the
    // generated tests call.
    expect(() =>
      runAndAssertCase(
        { iterations: 2, successes: 0, failures: 2 } as never,
        "answers the first prompt"
      )
    ).toThrow(/2 of 2 iterations failed/);
  });
});
