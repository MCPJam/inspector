/**
 * One credit refusal, every surface that words it. Each fixture is a refusal
 * body the backend writes (`sdk/tests/fixtures/credit-refusal-fixtures.json`);
 * every surface's first actionable sentence must be `formatCreditRecovery` of
 * its `recovery`, link included, and none may send the reader to the server
 * connection. A refusal from a backend without `recovery` names no step, and
 * only MCPJam's own stop refusal (credit exhaustion or a spend cap) may put
 * its step in front of the reader.
 *
 * The runner's own end-to-end stop is pinned in `evals-runner.test.ts`, and
 * the CLI's `Recovery:` line in `cli/tests/eval-credit-recovery.test.ts` (the
 * CLI's modules do not load under this workspace's resolver); both read this
 * corpus. This file holds the remaining surfaces to one sentence so a change
 * to any of them shows up as a disagreement here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assembleEvalRunDecisionSummary,
  deriveStageResults,
  formatCreditRecovery,
  NEXT_ACTION_BY_INFRA_CLASS,
  parseCreditRecovery,
} from "@mcpjam/sdk/contract";
import { describeError } from "@mcpjam/sdk";
import { runStopRefusal } from "../../../../shared/credit-exhaustion.js";
import { humanizeSwarmAttemptError } from "../../../../shared/swarm-attempt-error.js";
import { toInfraErrorProjection } from "../../../routes/v1/eval-infra-error-projection.js";
import { creditStopNote } from "../credit-stop.js";

type CreditRefusalFixture = {
  __name: string;
  stopsRun: boolean;
  body: Record<string, unknown> & { error: string; code: string };
  expectedRecovery: string | null;
  expectedUrl: string | null;
};

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../sdk/tests/fixtures/credit-refusal-fixtures.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { cases: CreditRefusalFixture[] };

const STEPLESS_STOP_NOTE =
  "Out of MCPJam credits. Completed results are saved; remaining iterations were skipped.";

/** How the hosted runner holds a refusal: the sentence and the raw body. */
const refusalOf = (fixture: CreditRefusalFixture) => ({
  message: fixture.body.error,
  details: JSON.stringify(fixture.body),
});

const derivation = deriveStageResults({
  authored: { mode: "model_driven", expectsToolCall: true, assertionCount: 1 },
  evidence: {
    setupSignals: {
      connection: { outcome: "ok" },
      discovery: { outcome: "ok" },
    },
    prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
    stepError: { source: "model" },
  },
  iteration: { status: "failed" },
});

describe.each(
  corpus.cases.map((fixture) => [fixture.__name, fixture] as const),
)("credit refusal %s", (_name, fixture) => {
  // The runner's gate: only a stop refusal's recovery is read.
  const recovery = runStopRefusal(refusalOf(fixture))?.recovery;
  const expected = fixture.stopsRun ? fixture.expectedRecovery : null;

  /** Every surface's sentence must lead with the expected one. */
  const expectLeads = (text: string | undefined) => {
    expect(text).toBeDefined();
    expect(text).not.toMatch(/server connection/i);
    if (expected === null) return;
    expect(text!.startsWith(expected)).toBe(true);
    expect(text).toContain(fixture.expectedUrl!);
  };

  it("is read off the refusal the runner holds", () => {
    expect(runStopRefusal(refusalOf(fixture)) !== undefined).toBe(
      fixture.stopsRun,
    );
    if (expected === null) {
      expect(recovery).toBeUndefined();
      return;
    }
    expect(formatCreditRecovery(recovery!)).toBe(expected);
    expect(recovery).toEqual(parseCreditRecovery(fixture.body.recovery));
  });

  it("words the run notes and every skipped trial", () => {
    const note = creditStopNote(recovery);
    if (expected === null) {
      expect(note).toBe(STEPLESS_STOP_NOTE);
      return;
    }
    expectLeads(note);
    expect(note).toContain("remaining iterations were skipped");
  });

  // What the runner stores (`metadata.creditRecovery`), read back by v1.
  const projected = toInfraErrorProjection(
    {
      class: "account_limit",
      layer: "platform",
      retryable: false,
      code: fixture.body.code,
    },
    // The fixture's own recovery, even where the runner records none, so the
    // projection's code gate is what keeps a non-credit refusal's step out.
    fixture.body.recovery ? { creditRecovery: fixture.body.recovery } : {},
  ).infraError;

  it("projects on the v1 iteration's infraError", () => {
    expect(projected?.class).toBe("account_limit");
    if (expected === null) {
      expect(projected).not.toHaveProperty("recovery");
      return;
    }
    expectLeads(formatCreditRecovery(projected!.recovery!));
  });

  it("is the decision summary's next action", () => {
    const nextAction = assembleEvalRunDecisionSummary({
      projectId: "project-1",
      run: { id: "run-1", status: "failed", result: "failed" },
      iterations: [
        {
          id: "iteration-1",
          iterationNumber: 1,
          status: "failed",
          result: "failed",
          error: fixture.body.error,
          stageResults: derivation.stageResults,
          failureCategory: derivation.failureCategory,
          stageAnalyzerVersion: derivation.stageAnalyzerVersion,
          infraError: projected,
        },
      ],
      page: { complete: true },
    }).diagnostics.items[0]!.nextAction;
    expectLeads(nextAction);
    if (expected === null) {
      expect(nextAction).toBe(NEXT_ACTION_BY_INFRA_CLASS.account_limit);
    }
  });

  it("is the error describer's first next step", () => {
    const described = describeError(
      Object.assign(new Error(fixture.body.error), { details: fixture.body }),
    );
    if (!described.slug.startsWith("provider/mcpjam_limit")) return;
    expectLeads(described.nextSteps[0]);
  });

  it("keeps the swarm's scrubbed prose readable", () => {
    const message = humanizeSwarmAttemptError(
      `swarm-agent https://x.convex.site/turn failed (429): ${JSON.stringify(fixture.body)}`,
    ).message;
    expect(message).not.toMatch(/https?:\/\//);
    expect(message).not.toMatch(/:\s*(?:BYOK|$)/);
  });
});
