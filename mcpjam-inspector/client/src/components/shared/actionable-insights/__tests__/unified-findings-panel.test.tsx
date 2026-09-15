/**
 * The unified-findings panel's presentation contract.
 *
 * The assertions here are the ones the experiment would be worthless without:
 * a model failure must not take observations off the screen, a deterministic
 * fallback must not be labelled as AI, "not built" / "known empty" /
 * "unavailable" must read as three different things, and a server-fix
 * affordance must appear only where the backend promoted the finding.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  const analyze = {
    available: true,
    pending: false,
    error: null,
    onRun: vi.fn(),
  };
  const result = render(
    <UnifiedFindingsPanel
      snapshot={snapshot()}
      findings={[finding()]}
      provenance={[provenance()]}
      observationState="ready"
      observationCoverage={coverage}
      mode="deterministic"
      analyze={analyze}
      {...props}
    />,
  );
  return { ...result, analyze };
}
const openWhy = () =>
  fireEvent.click(screen.getByRole("button", { name: "Why this fix?" }));

describe("walkthrough findings layout", () => {
  it("shows the problem and fix without experiment controls or expanded diagnostics", () => {
    const { analyze } = renderPanel();
    expect(screen.getByRole("heading", { name: "What broke" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "How to fix" })).toBeVisible();
    expect(screen.getByText(finding().recommendation)).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Experiment")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Build findings/i }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(analyze.onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Analyze findings" }));
    expect(analyze.onRun).toHaveBeenCalledTimes(1);
  });

  it("opens real failed and contrasting evidence in a drawer without generating", () => {
    const { analyze } = renderPanel({
      findings: [
        finding({
          evidence: [
            ...finding().evidence,
            {
              iterationId: "pass",
              kind: "contrast",
              excerpt: "Search returned the expected records.",
            },
          ],
        }),
      ],
    });
    expect(screen.queryByText("Authentication failed (401)")).toBeNull();
    openWhy();
    expect(screen.getByRole("dialog", { name: "Why this fix?" })).toBeVisible();
    expect(screen.getByText("Authentication failed (401)")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Successful comparison" }),
    ).toBeVisible();
    expect(
      screen.getByText("Search returned the expected records."),
    ).toBeVisible();
    expect(analyze.onRun).not.toHaveBeenCalled();
  });

  it("shows readable MCP text while preserving the complete recorded wrapper", () => {
    const excerpt =
      'Tool: run_eval_suite; call: c1; outcome: error\nResult: {"_meta":{"version":1},"content":[{"type":"text","text":"Choose a target before running the suite."}]}\nArguments: {}';
    renderPanel({
      findings: [
        finding({
          evidence: [{ kind: "tool_error", iterationId: "it_fail_1", excerpt }],
        }),
      ],
    });
    openWhy();
    expect(
      screen.getByText("Choose a target before running the suite."),
    ).toBeVisible();
    expect(screen.getByText("Full recorded excerpt")).toBeVisible();
    expect(
      screen
        .getByText("Full recorded excerpt")
        .parentElement?.querySelector("pre")?.textContent,
    ).toBe(excerpt);
  });

  it("restores keyboard focus when the evidence drawer closes", async () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "Why this fix?" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not invent a successful comparison", () => {
    renderPanel();
    openWhy();
    expect(
      screen.queryByRole("heading", { name: "Successful comparison" }),
    ).toBeNull();
  });

  it("routes evidence through typed locators and closes the drawer", async () => {
    const onOpenEvidence = vi.fn();
    renderPanel({ onOpenEvidence });
    openWhy();
    fireEvent.click(screen.getByTestId("finding-evidence-open"));
    expect(onOpenEvidence).toHaveBeenCalledWith({
      kind: "iteration",
      id: "it_fail_1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lists distinct affected trials, with all recorded links rather than only excerpts", () => {
    const onOpenEvidence = vi.fn();
    renderPanel({
      provenance: [
        provenance({
          affectedIterationIds: ["it_fail_1", "it_fail_2", "it_fail_2"],
        }),
      ],
      onOpenEvidence,
      iterationLabels: { it_fail_2: "Trial 9 · Search contacts" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "View 2 affected trials" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Trial 9 · Search contacts" }),
    );
    expect(onOpenEvidence).toHaveBeenCalledWith({
      kind: "iteration",
      id: "it_fail_2",
    });
  });

  it("omits navigation links when the host has no evidence route", () => {
    renderPanel();
    openWhy();
    expect(screen.queryByTestId("finding-evidence-open")).toBeNull();
  });

  it("collapses every additional finding behind one disclosure", () => {
    const second = finding({
      id: "second",
      title: "Missing confirmation",
      observed: "The final answer omitted the project name.",
    });
    renderPanel({ findings: [finding(), second] });
    expect(screen.queryByTestId("unified-finding")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "1 more finding · Missing confirmation",
      }),
    );
    expect(screen.getByTestId("unified-finding")).toBeVisible();
    expect(screen.getByText(second.observed)).toBeVisible();
  });

  it("copies an investigation for an unproven fix", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Copy fix prompt" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeVisible());
    expect(copied.text).toContain("Investigate a problem");
    expect(screen.getByTestId("finding-copy-prompt")).toHaveAttribute(
      "data-server-fix",
      "false",
    );
  });

  it("only exposes a server repair and pinned contract for a promoted finding", () => {
    renderPanel({
      findings: [
        finding({
          actionTarget: "mcp_server",
          actionability: "ready",
          target: {
            serverId: "crm",
            toolName: "search",
            surface: "description",
            snapshotHash: "hash",
            currentDefinition: {
              description: "Search records",
              truncated: false,
            },
          },
        }),
      ],
    });
    expect(screen.getByTestId("finding-copy-prompt")).toHaveAttribute(
      "data-server-fix",
      "true",
    );
    openWhy();
    expect(screen.getByTestId("unified-finding-contract")).toHaveTextContent(
      "Search records",
    );
  });

  it("does not offer a repository fix for an environment problem", () => {
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
});

describe("analysis states and provenance", () => {
  it("keeps recorded findings visible after a failed analysis", () => {
    renderPanel({
      analyze: {
        available: true,
        pending: false,
        error: "Provider returned 503",
        onRun: vi.fn(),
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider returned 503",
    );
    expect(screen.getByTestId("unified-finding-observed")).toHaveTextContent(
      finding().observed,
    );
  });
  it("uses a single pending action and retains the current finding", () => {
    renderPanel({
      analyze: { available: true, pending: true, error: null, onRun: vi.fn() },
    });
    expect(screen.getByRole("button", { name: "Analyzing…" })).toBeDisabled();
    expect(screen.getByTestId("unified-finding-observed")).toBeVisible();
  });
  it("distinguishes not analyzed, incomplete, and known-empty results", () => {
    const { unmount } = renderPanel({ snapshot: null, findings: [] });
    expect(
      screen.getByTestId("unified-findings-no-snapshot"),
    ).toHaveTextContent("Analyze this run");
    unmount();
    renderPanel({ findings: [], observationState: "partial" });
    expect(screen.getByTestId("unified-findings-empty")).toHaveTextContent(
      "does not mean the run passed",
    );
  });
  it("explains unavailable evidence", () => {
    renderPanel({ findings: [], observationState: "unavailable" });
    expect(
      screen.getByTestId("unified-findings-unavailable"),
    ).toHaveTextContent("isn’t enough recorded evidence");
  });
  it("does not obscure recorded execution errors with a generic empty finding", () => {
    renderPanel({
      findings: [],
      executionIssues: <p>Two trials hit the model limit.</p>,
    });
    expect(screen.getByText("Two trials hit the model limit.")).toBeVisible();
    expect(screen.queryByTestId("unified-findings-empty")).toBeNull();
  });
  it("reports backend availability and stale analysis without showing mode tabs", () => {
    renderPanel({
      backendUnavailableNote: "Findings temporarily unavailable",
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
      screen.getByTestId("unified-findings-backend-missing"),
    ).toBeVisible();
    expect(
      screen.getByTestId("unified-findings-stale-enrichment"),
    ).toHaveTextContent("Analyze again");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
  it("labels fallback recommendations accurately even in an AI result", () => {
    renderPanel({
      mode: "ai",
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
    });
    expect(screen.getByTestId("finding-prose-source")).toHaveTextContent(
      "Suggested next step",
    );
    expect(screen.getByTestId("finding-prose-source")).toHaveAttribute(
      "data-source",
      "deterministic",
    );
  });
  it("keeps judge coverage and uncertainty in the evidence drawer", () => {
    renderPanel({
      provenance: [
        provenance({
          basis: "judged",
          mechanismBasis: "sampled",
          populationCaveat: "No run-wide rate is claimed.",
          judgeCoverage: {
            evaluatorId: "judge",
            evaluatorLabel: "Completion",
            graded: 4,
            eligible: 20,
            nonGraded: { pending: 16, skipped: 0, errored: 0 },
          },
        }),
      ],
    });
    expect(screen.getByText("Recorded judge results")).toBeVisible();
    openWhy();
    expect(
      screen.getByTestId("unified-finding-judge-coverage"),
    ).toHaveTextContent("graded 4 of 20 eligible");
    expect(screen.getByTestId("unified-finding-caveat")).toHaveTextContent(
      "No run-wide rate",
    );
  });
  it("puts exclusions and rejected proposals behind compact coverage details", () => {
    renderPanel({
      observationState: "partial",
      observationCoverage: {
        ...coverage,
        analyzed: 14,
        exclusions: { chainUnverified: 6 },
      },
      snapshot: snapshot({ omittedGroups: 2 }),
    });
    expect(
      screen.getByTestId("unified-findings-coverage-summary"),
    ).toHaveTextContent(
      "Evidence covers 14 of 20 trials. Some evidence is incomplete.",
    );
    expect(screen.queryByTestId("unified-findings-exclusions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Coverage details" }));
    expect(screen.getByTestId("unified-findings-exclusions")).toHaveTextContent(
      "6 without a verified stage chain",
    );
    expect(screen.getByTestId("unified-findings-omitted")).toHaveTextContent(
      "2 further groups",
    );
  });
  it("shows AI-discovered issues with honest coverage even without stage-chain findings", () => {
    renderPanel({
      mode: "ai",
      observationState: "unavailable",
      findings: [
        finding({
          title: "Suite creation gets stuck retrying",
          observed: "Supporting evidence cited in 2 of 12 reviewed iterations.",
        }),
      ],
      provenance: [
        provenance({
          groupKind: "ai_discovery",
          proseOrigin: {
            title: "ai",
            rootCause: "ai",
            recommendation: "ai",
            acceptanceCriteria: "ai",
          },
        }),
      ],
      snapshot: snapshot({
        enrichment: {
          status: "ready",
          generatedAt: 123,
          modelUsed: "test-model",
          summary: "s",
          acceptedCount: 1,
          rejectedCount: 1,
          discovery: {
            reviewedIterations: 12,
            totalIterations: 16,
            reviewedFailedIterations: 8,
            totalFailedIterations: 8,
            missingTraces: 1,
            truncatedTraces: 2,
            omittedEvidence: 3,
          },
        },
      }),
    });
    expect(
      screen.getByTestId("unified-finding-discovered-title"),
    ).toHaveTextContent("Suite creation gets stuck retrying");
    expect(screen.queryByTestId("unified-findings-unavailable")).toBeNull();
    expect(
      screen.getByTestId("unified-findings-coverage-summary"),
    ).toHaveTextContent("Reviewed 8 of 8 failed trials and 4 passing examples");
    expect(screen.getByText("AI suggestion")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Coverage details" }));
    expect(
      screen.getByTestId("unified-findings-enrichment-note"),
    ).toHaveTextContent("3 evidence records omitted");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "1 proposals rejected",
    );
  });
});
