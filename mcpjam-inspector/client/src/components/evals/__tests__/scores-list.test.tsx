import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  buildEvaluationConfigSnapshot,
  errorScoreResult,
  finalizeScoreResult,
  notApplicableScoreResult,
  resolveScoreDefinition,
  skippedScoreResult,
} from "@mcpjam/sdk/contract";
import type { ScoreDefinition, ScoreResult } from "@mcpjam/sdk/contract";
import {
  ScoresList,
  isGatingScore,
  parseEvaluationConfig,
  parseIterationScores,
  parseScoreIntegrity,
  scoreFailsGate,
} from "../scores-list";

const GATING: ScoreDefinition = {
  scorerId: "refund-mentioned",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-refund",
  label: "refund is mentioned",
  deterministic: true,
  passThreshold: 1,
  role: "gating",
};

const ADVISORY: ScoreDefinition = {
  scorerId: "tone",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-tone",
  label: "tone",
  deterministic: false,
  passThreshold: 0.7,
  role: "advisory",
  model: "anthropic/claude-sonnet-4-6",
};

const GATING_TOLERANT: ScoreDefinition = {
  ...GATING,
  scorerId: "tolerant",
  implementationHash: "impl-tolerant",
  onError: "ignore",
};

const snapshot = buildEvaluationConfigSnapshot([
  GATING,
  ADVISORY,
  GATING_TOLERANT,
]);
const gate = resolveScoreDefinition(GATING);
const advisory = resolveScoreDefinition(ADVISORY);
const tolerant = resolveScoreDefinition(GATING_TOLERANT);

describe("parseIterationScores", () => {
  it("returns null when there is nothing to render", () => {
    expect(parseIterationScores(undefined)).toBeNull();
    expect(parseIterationScores({})).toBeNull();
    expect(parseIterationScores({ scores: "not-an-array" })).toBeNull();
  });

  it("keeps valid rows and drops malformed ones", () => {
    const good = finalizeScoreResult(gate, { kind: "scored", value: 1 });
    const rows = parseIterationScores({
      scores: [good, { garbage: true }, { ...good, passed: false }],
    });
    // Row 2 is structurally invalid; row 3 contradicts the derivation. Both
    // are dropped, and the operator still sees the verdict that IS valid —
    // deliberately more permissive than the public DTO, which is a trust
    // boundary and refuses partial data outright.
    expect(rows).toHaveLength(1);
    expect(rows?.[0].scorerId).toBe("refund-mentioned");
  });
});

describe("parseEvaluationConfig / parseScoreIntegrity", () => {
  it("round-trips a valid snapshot", () => {
    expect(parseEvaluationConfig({ evaluationConfig: snapshot })?.hash).toBe(
      snapshot.hash,
    );
  });

  it("returns null for a malformed snapshot", () => {
    expect(
      parseEvaluationConfig({ evaluationConfig: { hash: "x" } }),
    ).toBeNull();
    expect(parseEvaluationConfig({})).toBeNull();
  });

  it("only recognizes the known integrity verdict", () => {
    expect(
      parseScoreIntegrity({ scoreIntegrity: "score_integrity_invalid" }),
    ).toBe("score_integrity_invalid");
    expect(parseScoreIntegrity({ scoreIntegrity: "probably_fine" })).toBeNull();
    expect(parseScoreIntegrity({})).toBeNull();
  });
});

describe("gate helpers", () => {
  it("treats an unjoinable row as gating AND failing", () => {
    // Fails closed everywhere else; if the chip excluded it from the
    // denominator, a failed iteration would show "2 / 2 checks passed".
    const orphan: ScoreResult = {
      ...finalizeScoreResult(gate, { kind: "scored", value: 1 }),
      definitionHash: "0".repeat(64),
    };
    expect(isGatingScore(orphan, snapshot)).toBe(true);
    expect(scoreFailsGate(orphan, snapshot)).toBe(true);
  });

  it("never counts an advisory row against the gate", () => {
    const row = finalizeScoreResult(advisory, { kind: "scored", value: 0 });
    expect(isGatingScore(row, snapshot)).toBe(false);
    expect(scoreFailsGate(row, snapshot)).toBe(false);
  });

  it("honors onError on a gating row", () => {
    expect(scoreFailsGate(errorScoreResult(gate, "boom"), snapshot)).toBe(true);
    expect(
      scoreFailsGate(errorScoreResult(tolerant, "boom"), snapshot),
    ).toBe(false);
  });

  it("never gates on not_applicable", () => {
    expect(scoreFailsGate(notApplicableScoreResult(gate), snapshot)).toBe(false);
  });
});

describe("ScoresList", () => {
  function renderAll() {
    const scores = [
      finalizeScoreResult(gate, {
        kind: "scored",
        value: 1,
        rationale: "found the refund line",
      }),
      finalizeScoreResult(advisory, {
        kind: "scored",
        value: 0.4,
        rationale: "a bit curt",
      }),
      errorScoreResult(tolerant, "judge timed out"),
      skippedScoreResult(gate, "iteration errored before scoring"),
      notApplicableScoreResult(advisory, "no expectations configured"),
    ];
    render(
      <ScoresList scores={scores} evaluationConfig={snapshot} />,
    );
  }

  it("renders every status", () => {
    renderAll();
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText("FAIL")).toBeInTheDocument();
    expect(screen.getByText("ERROR")).toBeInTheDocument();
    expect(screen.getByText("SKIPPED")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
  });

  it("separates gating from advisory rather than merely annotating", () => {
    renderAll();
    // The single most misleading thing this view could do is let a red
    // advisory judge read as the reason a run failed.
    expect(screen.getByText("Gating")).toBeInTheDocument();
    expect(screen.getByText("Advisory")).toBeInTheDocument();
  });

  it("counts only gating rows in the header", () => {
    render(
      <ScoresList
        scores={[
          finalizeScoreResult(gate, { kind: "scored", value: 1 }),
          finalizeScoreResult(advisory, { kind: "scored", value: 0 }),
        ]}
        evaluationConfig={snapshot}
      />,
    );
    expect(
      screen.getByText("1 / 1 gating scores passed"),
    ).toBeInTheDocument();
  });

  it("renders a row with no matching definition as unresolved, not a crash", () => {
    const orphan: ScoreResult = {
      ...finalizeScoreResult(gate, { kind: "scored", value: 1 }),
      scorerId: "vanished",
      definitionHash: "0".repeat(64),
    };
    render(<ScoresList scores={[orphan]} evaluationConfig={snapshot} />);
    expect(
      screen.getByText(/Unresolved \(no matching definition\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/is treated as failing the gate/),
    ).toBeInTheDocument();
  });

  it("says so when there is no snapshot to join against", () => {
    render(
      <ScoresList
        scores={[finalizeScoreResult(gate, { kind: "scored", value: 1 })]}
        evaluationConfig={null}
      />,
    );
    expect(
      screen.getByText(/whether each one gates is unknown/),
    ).toBeInTheDocument();
  });

  it("surfaces an integrity downgrade prominently", () => {
    render(
      <ScoresList
        scores={[finalizeScoreResult(gate, { kind: "scored", value: 1 })]}
        evaluationConfig={snapshot}
        integrity="score_integrity_invalid"
      />,
    );
    // This path is otherwise silent by construction — the verdict just flips.
    expect(
      screen.getByText(/verdict was downgraded at ingest/),
    ).toBeInTheDocument();
  });

  it("renders nothing for an empty score set", () => {
    const { container } = render(
      <ScoresList scores={[]} evaluationConfig={snapshot} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
