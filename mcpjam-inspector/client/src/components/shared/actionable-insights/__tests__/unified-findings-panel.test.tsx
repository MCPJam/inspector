/**
 * The unified-findings panel's presentation contract.
 *
 * The assertions here are the ones the experiment would be worthless without:
 * a model failure must not take observations off the screen, a deterministic
 * fallback must not be labelled as AI, "not built" / "known empty" /
 * "unavailable" must read as three different things, and a server-fix
 * affordance must appear only where the backend promoted the finding.
 */
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnifiedFindingsPanel } from "../unified-findings-panel";
import type {
  ActionableFinding,
  InsightsFindingProvenance,
  UnifiedFindingsExperiment,
} from "@/lib/insights-envelope-api";

const copied = vi.hoisted(() => ({ text: "" }));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: async (text: string) => {
    copied.text = text;
    return true;
  },
}));

function finding(
  overrides: Partial<ActionableFinding> = {},
): ActionableFinding {
  return {
    id: "rf_aaaa000000000001",
    signalFingerprint: "sha256:fp1",
    title: '"search" failed (401) on server acme-crm in 6 of 20 iterations.',
    category: "tool_runtime",
    attribution: "unknown",
    actionTarget: "investigate",
    actionability: "investigate",
    severity: "high",
    confidence: "low",
    observed: '"search" failed (401) on server acme-crm in 6 of 20 iterations.',
    recommendation:
      "Open the exemplar sessions and identify the mechanism before changing anything.",
    acceptanceCriteria: [],
    affected: { count: 6, total: 20, unit: "iterations" },
    evidence: [
      {
        iterationId: "it_fail_1",
        kind: "tool_error",
        excerpt: "Authentication failed (401)",
        toolName: "search",
        errorCode: "401",
      },
    ],
    ...overrides,
  };
}

function provenance(
  overrides: Partial<InsightsFindingProvenance> = {},
): InsightsFindingProvenance {
  return {
    candidateId: "rf_aaaa000000000001",
    groupKind: "tool_failure",
    basis: "measured",
    mechanismBasis: "complete",
    affectedIterationIds: ["it_fail_1"],
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<NonNullable<UnifiedFindingsExperiment["snapshot"]>> = {},
): NonNullable<UnifiedFindingsExperiment["snapshot"]> {
  return {
    builtAt: 1_757_800_000_000,
    sourceRevision: "rev-1",
    minerVersion: 1,
    omittedGroups: 0,
    deterministicFindings: [finding()],
    provenance: [provenance()],
    enrichment: null,
    baseline: null,
    ...overrides,
  };
}

const coverage = {
  unit: "iterations" as const,
  analyzed: 20,
  total: 20,
  gradedCount: 0,
  exclusions: {},
};

function renderPanel(
  props: Partial<Parameters<typeof UnifiedFindingsPanel>[0]> = {},
) {
  const onModeChange = vi.fn();
  const view = render(
    <UnifiedFindingsPanel
      snapshot={snapshot()}
      findings={[finding()]}
      provenance={[provenance()]}
      observationState="ready"
      observationCoverage={coverage}
      mode="deterministic"
      onModeChange={onModeChange}
      build={{ available: true, pending: false, error: null, onRun: vi.fn() }}
      enrich={{ available: true, pending: false, error: null, onRun: vi.fn() }}
      {...props}
    />,
  );
  return { ...view, onModeChange };
}

describe("the two operations are distinguishable and independent", () => {
  it("says the deterministic operation does not use AI", () => {
    renderPanel();
    expect(
      screen.getByText(
        /Reads this run's recorded evidence\. Does not use AI\./,
      ),
    ).toBeTruthy();
  });

  it("never runs anything on mount", () => {
    const build = {
      available: true,
      pending: false,
      error: null,
      onRun: vi.fn(),
    };
    const enrich = {
      available: true,
      pending: false,
      error: null,
      onRun: vi.fn(),
    };
    renderPanel({ build, enrich });
    expect(build.onRun).not.toHaveBeenCalled();
    expect(enrich.onRun).not.toHaveBeenCalled();
  });

  it("does not generate when the comparison view changes", () => {
    const enrich = {
      available: true,
      pending: false,
      error: null,
      onRun: vi.fn(),
    };
    const { onModeChange } = renderPanel({
      enrich,
      snapshot: snapshot({
        enrichment: {
          status: "ready",
          generatedAt: 1,
          modelUsed: "m",
          summary: "s",
          acceptedCount: 1,
          rejectedCount: 0,
        },
      }),
    });
    fireEvent.click(screen.getByTestId("unified-findings-mode-ai"));
    expect(onModeChange).toHaveBeenCalledWith("ai");
    expect(enrich.onRun).not.toHaveBeenCalled();
  });

  it("does not generate when evidence is opened", () => {
    const enrich = {
      available: true,
      pending: false,
      error: null,
      onRun: vi.fn(),
    };
    renderPanel({ enrich });
    fireEvent.click(screen.getByTestId("unified-finding-toggle"));
    expect(enrich.onRun).not.toHaveBeenCalled();
  });

  it("keeps a model failure out of the deterministic operation's state", () => {
    renderPanel({
      enrich: {
        available: true,
        pending: false,
        error: "provider returned 503",
        onRun: vi.fn(),
      },
    });
    expect(screen.getByTestId("unified-findings-enrich-error")).toBeTruthy();
    expect(screen.queryByTestId("unified-findings-build-error")).toBeNull();
    // The observation is still on screen — the property the experiment tests.
    expect(
      screen.getByTestId("unified-finding-observed").textContent,
    ).toContain('"search" failed (401)');
  });

  it("shows a build failure without claiming the model failed", () => {
    renderPanel({
      build: {
        available: true,
        pending: false,
        error: "Evidence changed; rebuild findings.",
        onRun: vi.fn(),
      },
    });
    expect(
      screen.getByTestId("unified-findings-build-error").textContent,
    ).toContain("Evidence changed");
    expect(screen.queryByTestId("unified-findings-enrich-error")).toBeNull();
  });
});

describe("the states are four different sentences", () => {
  it("a missing snapshot says findings have not been built", () => {
    renderPanel({ snapshot: null, findings: [], provenance: [] });
    expect(
      screen.getByTestId("unified-findings-no-snapshot").textContent,
    ).toContain("Findings have not been built for this run");
  });

  it("a known-empty result is not the same as unavailable", () => {
    renderPanel({
      findings: [],
      snapshot: snapshot({ deterministicFindings: [] }),
    });
    expect(screen.getByTestId("unified-findings-empty")).toBeTruthy();
    expect(screen.queryByTestId("unified-findings-unavailable")).toBeNull();
  });

  it("unavailable says nothing could be measured", () => {
    renderPanel({
      findings: [],
      observationState: "unavailable",
      snapshot: snapshot({ deterministicFindings: [] }),
    });
    expect(
      screen.getByTestId("unified-findings-unavailable").textContent,
    ).toContain("different from finding nothing wrong");
  });

  it("a partial empty result refuses to read as clean", () => {
    renderPanel({
      findings: [],
      observationState: "partial",
      snapshot: snapshot({ deterministicFindings: [] }),
    });
    expect(screen.getByTestId("unified-findings-empty").textContent).toContain(
      "incomplete rather than clean",
    );
  });

  it("an older backend explains the pairing instead of failing silently", () => {
    renderPanel({
      snapshot: null,
      findings: [],
      backendUnavailableNote: "the connected backend does not serve it",
    });
    expect(
      screen.getByTestId("unified-findings-backend-missing").textContent,
    ).toContain("does not serve it");
  });
});

describe("provenance labelling", () => {
  it("labels deterministic fallback prose as standard guidance", () => {
    // The lead finding renders expanded — its evidence and next step are the
    // first thing a reader needs, not a disclosure they have to find.
    renderPanel();
    const sources = screen
      .getAllByTestId("finding-prose-source")
      .map((node) => node.getAttribute("data-source"));
    expect(sources.every((source) => source === "deterministic")).toBe(true);
    expect(screen.getAllByText("Standard guidance").length).toBeGreaterThan(0);
  });

  it("labels a model-written field as an AI explanation, field by field", () => {
    renderPanel({
      mode: "ai",
      findings: [
        finding({
          title: "Expired service credential on the CRM connector",
          rootCause: "The pinned token expired mid-run.",
        }),
      ],
      provenance: [
        provenance({
          proseOrigin: {
            title: "ai",
            rootCause: "ai",
            recommendation: "deterministic",
            acceptanceCriteria: "deterministic",
          },
        }),
      ],
      snapshot: snapshot({
        enrichment: {
          status: "ready",
          generatedAt: 1_757_800_000_000,
          modelUsed: "openai/gpt-5.4-mini",
          summary: "s",
          acceptedCount: 1,
          rejectedCount: 2,
        },
      }),
    });
    const detail = screen.getByTestId("unified-finding-detail");
    const cause = within(detail).getByText("Proposed cause").parentElement!;
    expect(
      within(cause)
        .getByTestId("finding-prose-source")
        .getAttribute("data-source"),
    ).toBe("ai");
    const next = within(detail).getByText("What to investigate").parentElement!;
    expect(
      within(next)
        .getByTestId("finding-prose-source")
        .getAttribute("data-source"),
    ).toBe("deterministic");
  });

  it("reports rejected model rows rather than celebrating nonempty output", () => {
    renderPanel({
      mode: "ai",
      snapshot: snapshot({
        enrichment: {
          status: "ready",
          generatedAt: 1_757_800_000_000,
          modelUsed: "openai/gpt-5.4-mini",
          summary: "s",
          acceptedCount: 1,
          rejectedCount: 2,
        },
      }),
    });
    expect(
      screen.getByTestId("unified-findings-enrichment-note").textContent,
    ).toContain("2 rows were rejected");
  });

  it("says a judged claim is a judgment, with its recorded coverage", () => {
    renderPanel({
      provenance: [
        provenance({
          basis: "judged",
          judgeCoverage: {
            evaluatorId: "rubric:abc",
            evaluatorLabel: "the pinned rubric abc",
            graded: 12,
            eligible: 14,
            nonGraded: { pending: 1, skipped: 1, errored: 0 },
          },
        }),
      ],
    });
    expect(
      screen.getByTestId("unified-finding-basis").getAttribute("data-basis"),
    ).toBe("judged");
    expect(
      screen.getByTestId("unified-finding-judge-coverage").textContent,
    ).toContain("graded 12 of 14 eligible");
  });

  it("repeats a sampled-mechanism caveat instead of implying a run-wide rate", () => {
    renderPanel({
      provenance: [
        provenance({
          mechanismBasis: "sampled",
          populationCaveat: "no run-wide rate is claimed",
        }),
      ],
    });
    expect(screen.getByTestId("unified-finding-caveat").textContent).toContain(
      "no run-wide rate is claimed",
    );
  });

  it("marks a stale enrichment as withheld rather than showing it", () => {
    renderPanel({
      snapshot: snapshot({
        enrichment: {
          status: "stale",
          generatedAt: 1,
          modelUsed: "m",
          summary: "s",
          acceptedCount: 0,
          rejectedCount: 0,
        },
      }),
    });
    expect(
      screen.getByTestId("unified-findings-stale-enrichment").textContent,
    ).toContain("not being shown");
    expect(
      screen.getByTestId("unified-findings-mode-ai").hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("actions stay behind the backend's own gate", () => {
  it("an unproven finding offers an investigation, not a server fix", () => {
    renderPanel();
    const button = screen.getByTestId("finding-copy-prompt");
    expect(button.getAttribute("data-server-fix")).toBe("false");
    expect(button.textContent).toContain("Copy investigation prompt");
    expect(screen.queryByTestId("unified-finding-contract")).toBeNull();
  });

  it("a promoted finding offers the server fix and shows the pinned contract", () => {
    const promoted = finding({
      actionTarget: "mcp_server",
      actionability: "ready",
      attribution: "server_runtime",
      confidence: "high",
      recommendation: "Refresh the pinned credential before the run starts.",
      acceptanceCriteria: ["search returns 200 for the same query"],
      target: {
        serverId: "acme-crm",
        toolName: "search",
        surface: "handler",
        snapshotHash: "sha256:snap",
        currentDefinition: { truncated: false, description: "Search records." },
      },
    });
    renderPanel({ findings: [promoted] });
    expect(
      screen.getByTestId("finding-copy-prompt").getAttribute("data-server-fix"),
    ).toBe("true");
    expect(screen.getByTestId("unified-finding-contract")).toBeTruthy();
    fireEvent.click(screen.getByTestId("finding-copy-prompt"));
  });

  it("an environment row offers no prompt at all", () => {
    renderPanel({
      findings: [
        finding({
          actionTarget: "environment",
          actionability: "informational",
        }),
      ],
    });
    expect(screen.queryByTestId("finding-copy-prompt")).toBeNull();
  });

  it("routes evidence through a TYPED locator, never a raw id", () => {
    const onOpenEvidence = vi.fn();
    renderPanel({ onOpenEvidence });
    fireEvent.click(screen.getByTestId("finding-evidence-open"));
    expect(onOpenEvidence).toHaveBeenCalledWith({
      kind: "iteration",
      id: "it_fail_1",
    });
  });

  it("omits the evidence link entirely when no callback is supplied", () => {
    renderPanel();
    expect(screen.queryByTestId("finding-evidence-open")).toBeNull();
  });
});

describe("lead and secondary presentation", () => {
  it("opens the lead finding and leaves the secondary ones folded", () => {
    const second = finding({
      id: "rf_aaaa000000000002",
      observed: '8 of 10 iterations that reached "connection" failed there.',
    });
    renderPanel({
      findings: [finding(), second],
      provenance: [provenance(), provenance({ candidateId: second.id })],
      snapshot: snapshot({ deterministicFindings: [finding(), second] }),
    });
    expect(screen.getByTestId("unified-finding-lead")).toBeTruthy();
    // One detail block open: the lead's.
    expect(screen.getAllByTestId("unified-finding-detail")).toHaveLength(1);
    fireEvent.click(screen.getAllByTestId("unified-finding-toggle")[1]!);
    expect(screen.getAllByTestId("unified-finding-detail")).toHaveLength(2);
  });
});

describe("coverage is reported, not implied", () => {
  it("names the exclusions and the omitted groups", () => {
    renderPanel({
      observationState: "partial",
      observationCoverage: {
        ...coverage,
        analyzed: 2,
        total: 8,
        exclusions: { chainMissing: 2, chainVersionAhead: 2 },
      },
      snapshot: snapshot({ omittedGroups: 6 }),
    });
    const text = screen.getByTestId("unified-findings-coverage").textContent;
    expect(text).toContain("Analyzed 2 of 8 iterations");
    expect(text).toContain("does not describe the whole run");
    expect(
      screen.getByTestId("unified-findings-exclusions").textContent,
    ).toContain("2 with no recorded contract chain");
    expect(
      screen.getByTestId("unified-findings-omitted").textContent,
    ).toContain("6 further groups");
  });
});
