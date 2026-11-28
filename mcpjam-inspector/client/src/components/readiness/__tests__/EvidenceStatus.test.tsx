/**
 * Every result says how far its evidence still holds, as the SDK placed it:
 * established, inconclusive, stale with the answers that changed, not tested
 * or blocked with the reason.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  directoryFlowField,
  placeDirectoryResults,
  type DirectoryAnswer,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { FieldLabels } from "../EvidenceStatus";
import { McpjamChecks } from "../McpjamChecks";

type Finding = PlacedFinding["finding"];

function finding(id: string, rest: Partial<Finding>): Finding {
  return {
    id,
    title: `Check ${id}`,
    lane: "submission-artifacts",
    class: "required",
    status: "satisfied",
    source: {},
    provenance: "declared",
    intrusiveness: "passive",
    evaluatedAt: "2026-11-12T12:00:00.000Z",
    engineVersion: "test",
    ...rest,
  };
}

const graded: DirectoryAnswer[] = [
  {
    key: "useCases.pairs",
    value: [{ useCase: "Run a suite", examplePrompt: "Run checkout." }],
    origin: "set",
  },
  { key: "useCases.prerequisites", value: "An account.", origin: "set" },
];

/** The SDK's placement, the way the API places a run's results. */
function placed(findings: Finding[], answers = graded): PlacedFinding[] {
  return placeDirectoryResults({
    flow: CLAUDE_CONNECTOR_FLOW,
    answers,
    findings,
    gradedAnswers: graded,
  }).flatMap((step) => step.findings);
}

function draw(entries: PlacedFinding[]) {
  const labelOf = (key: string) =>
    directoryFlowField(CLAUDE_CONNECTOR_FLOW, key)?.label ?? key;
  return render(
    <FieldLabels.Provider value={labelOf}>
      <McpjamChecks findings={entries} />
    </FieldLabels.Provider>,
  );
}

describe("evidence status on a result", () => {
  it("established: the badge alone", () => {
    const entries = placed([finding("claude.submission.use-cases", {})]);
    expect(entries[0]?.evidenceStatus).toBe("established");
    draw(entries);
    expect(screen.getByText("Established")).toBeVisible();
    expect(screen.queryByText(/Run checks again/)).toBeNull();
  });

  it("stale: names the answers that changed after the run", () => {
    const now = [
      graded[0],
      { key: "useCases.prerequisites", value: "A paid plan.", origin: "set" },
    ] satisfies DirectoryAnswer[];
    const entries = placed([finding("claude.submission.use-cases", {})], now);
    expect(entries[0]?.staleBecause).toEqual(["useCases.prerequisites"]);
    draw(entries);
    expect(screen.getByText("Stale")).toBeVisible();
    expect(
      screen.getByText(
        "Prerequisites changed after this run. Run checks again to update it.",
      ),
    ).toBeVisible();
  });

  it("blocked: the reason a failed dependency gave, and what to do", () => {
    const entries = placed([
      finding("claude.submission.access-matches-annotations", {
        status: "not-evaluated",
        notEvaluatedReason:
          "blocked: the server could not be reached: fetch failed",
      }),
    ]);
    expect(entries[0]?.evidenceStatus).toBe("blocked");
    draw(entries);
    expect(screen.getByText("Blocked")).toBeVisible();
    expect(
      screen.getByText(
        "Blocked because the server could not be reached: fetch failed. Run checks again once that is fixed.",
      ),
    ).toBeVisible();
    // The raw reason is not repeated as the result's detail.
    expect(screen.queryByText(/^blocked:/)).toBeNull();
  });

  it("not tested: the run's own reason", () => {
    const entries = placed([
      finding("claude.submission.use-cases", {
        status: "not-evaluated",
        notEvaluatedReason:
          "this check reads a connector submission's answers, and this run had none.",
      }),
    ]);
    expect(entries[0]?.evidenceStatus).toBe("not-tested");
    draw(entries);
    expect(screen.getByText("Not tested")).toBeVisible();
    expect(
      screen.getByText(
        "Not tested because this check reads a connector submission's answers, and this run had none.",
      ),
    ).toBeVisible();
  });

  it("inconclusive: an unsure model flag reads as a likely flag, never a pass", () => {
    const entries = placed([
      finding("claude.descriptions.directs-to-tool", {
        class: "heuristic",
        status: "informational",
        provenance: "llm",
        details: { confidence: "low" },
      }),
    ]);
    expect(entries[0]?.evidenceStatus).toBe("inconclusive");
    draw(entries);
    expect(screen.getByText("Inconclusive")).toBeVisible();
    expect(screen.getByText("Likely flag")).toBeVisible();
    expect(
      screen.getByText(
        "The model that flagged this was unsure. Check the text yourself before you change it.",
      ),
    ).toBeVisible();
  });
});
