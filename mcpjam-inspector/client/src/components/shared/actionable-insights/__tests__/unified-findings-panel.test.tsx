/**
 * The unified-findings panel's presentation contract.
 *
 * The assertions here are the ones the experiment would be worthless without:
 * a model failure must not take observations off the screen, a deterministic
 * fallback must not be labelled as AI, "not built" / "known empty" /
 * "unavailable" must read as three different things, and a server-fix
 * affordance must appear only where the backend promoted the finding.
 */
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnifiedFindingsPanel } from "../unified-findings-panel";
import type {
  ActionableFinding,
  InsightsFindingProvenance,
  UnifiedFindings,
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
  overrides: Partial<NonNullable<UnifiedFindings["snapshot"]>> = {},
): NonNullable<UnifiedFindings["snapshot"]> {
  return {
    builtAt: 1_757_800_000_000,
    sourceRevision: "rev-1",
    minerVersion: 1,
    omittedGroups: 0,
    deterministicFindings: [finding()],
    provenance: [provenance()],
    enrichment: null,
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
const openDetails = () =>
  fireEvent.click(screen.getByRole("button", { name: "See details" }));

describe("walkthrough findings layout", () => {
  it("keeps findings in the existing slot instead of duplicating the recorded summary", () => {
    renderPanel({ fallback: <p>Recorded diagnostic summary</p> });
    expect(screen.getByTestId("unified-findings-list")).toBeVisible();
    expect(screen.queryByText("Recorded diagnostic summary")).toBeNull();
  });

  it("shows the problem and fix without experiment controls or expanded diagnostics", () => {
    const { analyze } = renderPanel();
    expect(screen.getByRole("heading", { name: "What broke" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "How to fix" })).toBeVisible();
    expect(screen.getByText(finding().recommendation)).toBeVisible();
    expect(screen.queryByTestId("affected-iterations")).toBeNull();
    expect(screen.getByRole("button", { name: "See details" })).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Experiment")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Build findings/i }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(analyze.onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Analyze/ })).toBeNull();
  });

  it("opens the details sheet without recorded evidence or a successful comparison", () => {
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
    openDetails();
    const details = screen.getByRole("dialog", { name: "Finding details" });
    expect(details).toBeVisible();
    expect(
      within(details).getByRole("heading", { name: "What broke" }),
    ).toBeVisible();
    expect(
      within(details).getByRole("heading", { name: "How to fix" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Recorded evidence" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Successful comparison" }),
    ).toBeNull();
    expect(
      screen.queryByText("Search returned the expected records."),
    ).toBeNull();
    expect(analyze.onRun).not.toHaveBeenCalled();
  });

  it("restores keyboard focus when the evidence drawer closes", async () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "See details" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("routes an affected iteration through a typed locator and closes the drawer", async () => {
    const onOpenEvidence = vi.fn();
    renderPanel({
      onOpenEvidence,
      iterationRows: {
        it_fail_1: {
          iterationId: "it_fail_1",
          caseTitle: "Search contacts",
          iterationNumber: 3,
          client: "Claude",
          model: "gpt-5.4-mini",
          result: "failed",
          canOpen: true,
        },
      },
    });
    openDetails();
    fireEvent.click(
      within(screen.getByTestId("affected-iterations")).getByRole("button", {
        name: /^Open$/,
      }),
    );
    expect(onOpenEvidence).toHaveBeenCalledWith({
      kind: "iteration",
      id: "it_fail_1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names every affected iteration in the details sheet, including ones this page has not loaded", () => {
    const onOpenEvidence = vi.fn();
    renderPanel({
      provenance: [
        provenance({
          affectedIterationIds: ["it_fail_1", "it_fail_2", "it_fail_2"],
        }),
      ],
      onOpenEvidence,
      iterationRows: {
        it_fail_2: {
          iterationId: "it_fail_2",
          caseTitle: "Search contacts",
          iterationNumber: 9,
          client: "Claude",
          model: "gpt-5.4-mini",
          result: "failed",
          canOpen: true,
        },
      },
    });
    expect(screen.queryByTestId("affected-iterations")).toBeNull();
    openDetails();
    const list = screen.getByTestId("affected-iterations");
    expect(list).toHaveTextContent("Search contacts");
    expect(list).toHaveTextContent("Iteration 9");
    expect(list).toHaveTextContent("Failed");
    // The id with no loaded row is listed, never silently dropped.
    expect(list).toHaveTextContent("Iteration not loaded on this page");
    expect(list).toHaveTextContent("Not loaded");
    fireEvent.click(within(list).getByRole("button", { name: /^Open$/ }));
    expect(onOpenEvidence).toHaveBeenCalledWith({
      kind: "iteration",
      id: "it_fail_2",
    });
  });

  it("omits navigation links when the host has no evidence route", () => {
    renderPanel();
    openDetails();
    expect(
      within(screen.getByTestId("affected-iterations")).queryByRole("button", {
        name: /^Open$/,
      }),
    ).toBeNull();
  });

  it("pages every finding from one carousel in the findings header", () => {
    renderPanel({
      findings: [
        finding(),
        finding({
          id: "second",
          title: "Missing confirmation",
          observed: "The final answer omitted the project name.",
        }),
        finding({
          id: "third",
          title: "Wrong host",
          observed: "The model never sent a host.",
        }),
      ],
    });
    expect(
      screen.getByTestId("unified-findings-carousel-index"),
    ).toHaveTextContent("1 of 3");
    expect(
      screen.getByRole("button", { name: "Previous finding" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Next finding" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/more findings/i)).toBeNull();
    expect(screen.getByTestId("unified-finding-lead")).toBeVisible();
    expect(screen.getAllByTestId("unified-finding")).toHaveLength(2);
    expect(screen.getByTestId("unified-findings-see-all")).toBeVisible();
  });

  it("opens every finding as a stacked preview and drills into details", () => {
    renderPanel({
      findings: [
        finding(),
        finding({
          id: "second",
          title: "Missing confirmation",
          observed: "The final answer omitted the project name.",
          evidence: [
            {
              kind: "tool_error",
              iterationId: "it_2",
              excerpt: "No project name in the final answer.",
            },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    const catalog = screen.getByRole("dialog", { name: "All findings" });
    expect(catalog).toBeVisible();
    const previews = within(catalog).getAllByTestId(
      "unified-findings-all-preview",
    );
    expect(previews).toHaveLength(2);
    expect(previews[1]).toHaveTextContent(
      "The final answer omitted the project name.",
    );
    fireEvent.click(previews[1]);
    const details = screen.getByRole("dialog", { name: "Finding details" });
    expect(details).toBeVisible();
    expect(
      within(details).getByRole("heading", { name: "What broke" }),
    ).toBeVisible();
    expect(
      within(details).getByRole("heading", { name: "How to fix" }),
    ).toBeVisible();
    expect(details).toHaveTextContent(
      "The final answer omitted the project name.",
    );
    fireEvent.click(screen.getByTestId("unified-findings-all-back"));
    expect(screen.getByRole("dialog", { name: "All findings" })).toBeVisible();
  });

  it("opens the evidence sheet from the current carousel slide", () => {
    const second = finding({
      id: "second",
      title: "Missing confirmation",
      observed: "The final answer omitted the project name.",
      evidence: [
        {
          kind: "tool_error",
          iterationId: "it_2",
          excerpt: "No project name in the final answer.",
        },
      ],
    });
    renderPanel({ findings: [finding(), second] });
    expect(screen.getByTestId("unified-findings-see-all")).toBeVisible();
    expect(screen.getByTestId("unified-findings-carousel")).toBeVisible();
    expect(screen.getByRole("region", { name: "Findings" })).toBeVisible();
    expect(
      screen.getByTestId("unified-findings-carousel-index"),
    ).toHaveTextContent("1 of 2");
    const lead = screen.getByTestId("unified-finding-lead");
    expect(
      within(lead).getByRole("heading", { name: "What broke" }),
    ).toBeVisible();
    expect(
      within(lead).getByRole("heading", { name: "How to fix" }),
    ).toBeVisible();
    fireEvent.click(within(lead).getByRole("button", { name: "See details" }));
    const details = screen.getByRole("dialog", { name: "Finding details" });
    expect(details).toBeVisible();
    expect(
      within(details).getByRole("heading", { name: "What broke" }),
    ).toBeVisible();
    expect(details).toHaveTextContent(
      '"search" failed (401) on server acme-crm in 6 of 20 iterations.',
    );
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
    openDetails();
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
  it("orders findings by what was measured, not by what a model narrated", () => {
    // A narrated finding must not jump the queue: ordering inputs are the
    // actionability, the severity and the affected count — all recorded
    // before any model ran.
    const bigger = finding({
      id: "rf_aaaa000000000002",
      observed:
        "`create_eval_suite` rejected the arguments in 6 of 40 iterations.",
      affected: { count: 6, total: 40, unit: "iterations" },
    });
    renderPanel({
      findings: [bigger, finding()],
      provenance: [
        provenance({
          candidateId: bigger.id,
        }),
        provenance({
          proseOrigin: {
            observed: "ai",
            title: "ai",
            rootCause: "ai",
            recommendation: "ai",
            acceptanceCriteria: "ai",
          },
        }),
      ],
    });
    // Backticked tool names render as <code>, so the assertion is on the
    // words the reader sees.
    expect(
      within(screen.getByTestId("unified-finding-lead")).getByTestId(
        "unified-finding-observed",
      ),
    ).toHaveTextContent("rejected the arguments in 6 of 40 iterations.");
  });

  it.each([
    ["reading", "Reading iterations 12/40"],
    ["grouping", "Grouping problems…"],
    ["checking", "Checking evidence…"],
  ] as const)(
    "shows the %s phase without hiding measured findings",
    (phase, label) => {
      renderPanel({
        analyze: {
          available: true,
          pending: true,
          error: null,
          onRun: vi.fn(),
        },
        analysis: {
          phase,
          progress: { done: 12, total: 40, unit: "iterations" },
          models: [],
          completeness: { iterationReports: 10, total: 40, missingTraces: 2 },
        },
      });
      expect(screen.getByTestId("unified-findings-panel")).toHaveAttribute(
        "data-analysis-phase",
        phase,
      );
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByTestId("unified-finding-observed")).toBeVisible();
    },
  );

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
  it("shows pending status and retains the current finding", () => {
    renderPanel({
      analyze: { available: true, pending: true, error: null, onRun: vi.fn() },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Analyzing…");
    expect(screen.getByTestId("unified-finding-observed")).toBeVisible();
  });
  it.each(["run", "analysis", "build"])(
    "shows a skeleton while %s is pending, then shows settled incomplete evidence",
    (pendingSource) => {
      const { unmount } = renderPanel({
        findings: [],
        observationState: "partial",
        runPending: pendingSource === "run",
        ...(pendingSource === "analysis"
          ? {
              analyze: {
                available: true,
                pending: true,
                error: null,
                onRun: vi.fn(),
              },
            }
          : {}),
        ...(pendingSource === "build"
          ? {
              build: {
                available: true,
                pending: true,
                error: null,
                onRun: vi.fn(),
              },
            }
          : {}),
      });
      expect(screen.getByLabelText("Loading findings")).toBeVisible();
      expect(
        screen.queryByTestId("unified-findings-empty"),
      ).not.toBeInTheDocument();
      unmount();
      renderPanel({ findings: [], observationState: "partial" });
      expect(
        screen.queryByLabelText("Loading findings"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("unified-findings-empty")).toBeVisible();
    },
  );
  it("distinguishes not analyzed, incomplete, and known-empty results", () => {
    const { unmount } = renderPanel({ snapshot: null, findings: [] });
    expect(
      screen.queryByTestId("unified-findings-no-snapshot"),
    ).not.toBeInTheDocument();
    unmount();
    renderPanel({ findings: [], observationState: "partial" });
    expect(screen.getByTestId("unified-findings-empty")).toHaveTextContent(
      "does not mean the run passed",
    );
  });
  it("offers the free build, not the metered analysis, when nothing is built", () => {
    const build = {
      available: true,
      pending: false,
      error: null,
      onRun: vi.fn(),
    };
    renderPanel({ snapshot: null, findings: [], build });
    // "Analyze" means the model and it spends; a missing deterministic
    // snapshot needs neither, and the copy must not imply otherwise.
    expect(
      screen.getByTestId("unified-findings-no-snapshot"),
    ).toHaveTextContent("does not call a model");
    fireEvent.click(screen.getByRole("button", { name: "Build findings" }));
    expect(build.onRun).toHaveBeenCalledTimes(1);
  });

  it("explains unavailable evidence", () => {
    renderPanel({ findings: [], observationState: "unavailable" });
    expect(
      screen.getByTestId("unified-findings-unavailable"),
    ).toHaveTextContent("isn’t enough recorded evidence");
  });
  it("explains excluded trials when findings are empty", () => {
    renderPanel({
      findings: [],
      observationCoverage: {
        total: 16,
        analyzed: 7,
        gradedCount: 7,
        exclusions: { chainUnverified: 9, notTerminal: 1 },
      } as never,
    });
    expect(screen.getByTestId("unified-findings-empty")).toBeVisible();
    const summary = screen.getByTestId("unified-findings-exclusion-summary");
    expect(summary).toHaveTextContent(
      "9 iterations without a verified stage chain",
    );
    expect(summary).toHaveTextContent(/\b1 iteration\b/);
  });
  it("reports backend availability and stale analysis without showing mode tabs", () => {
    renderPanel({
      backendUnavailableNote: "Findings temporarily unavailable",
      snapshot: snapshot({
        enrichment: {
          status: "stale",
          generatedAt: 1,
          modelUsed: "m",
          discovery: {
            reviewedIterations: 0,
            totalIterations: 0,
            reviewedFailedIterations: 0,
            totalFailedIterations: 0,
            missingTraces: 0,
            truncatedTraces: 0,
            omittedEvidence: 0,
          },
        },
      }),
    });
    expect(
      screen.getByTestId("unified-findings-backend-missing"),
    ).toBeVisible();
    expect(
      screen.getByTestId("unified-findings-stale-enrichment"),
    ).toHaveTextContent("The evidence changed after this analysis ran.");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
  it("does not label the fix as standard guidance or AI explanation", () => {
    renderPanel({
      mode: "ai",
      provenance: [
        provenance({
          proseOrigin: {
            observed: "deterministic",
            title: "ai",
            rootCause: "ai",
            recommendation: "deterministic",
            acceptanceCriteria: "deterministic",
          },
        }),
      ],
    });
    expect(screen.queryByTestId("finding-prose-source")).toBeNull();
    expect(screen.queryByText("Standard guidance")).toBeNull();
    expect(screen.queryByText("AI explanation")).toBeNull();
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
    openDetails();
    expect(
      screen.getByTestId("unified-finding-judge-coverage"),
    ).toHaveTextContent("graded 4 of 20 eligible");
    expect(screen.getByTestId("unified-finding-caveat")).toHaveTextContent(
      "No run-wide rate",
    );
  });
  it("renders suite recurrence without describing missing history as new", () => {
    renderPanel({
      mode: "ai",
      provenance: [
        provenance({
          recurrence: {
            claimId: "claim",
            occurrences: 2,
            analyzedRuns: 3,
            firstSeenAt: Date.UTC(2026, 8, 16),
            firstSourceId: "run1",
            novelty: "measured",
          },
        }),
      ],
    });
    openDetails();
    expect(screen.getByTestId("unified-finding-recurrence")).toHaveTextContent(
      "Seen in 2 of this suite’s last 3 analyzed runs, first on Sep 16, 2026.",
    );
  });
  it("omits recurrence for results from an older backend", () => {
    renderPanel({ mode: "ai", provenance: [provenance()] });
    openDetails();
    expect(screen.queryByTestId("unified-finding-recurrence")).toBeNull();
  });
  it("discloses proposed trials that were not verified, and stays quiet when all were", () => {
    renderPanel({
      mode: "ai",
      provenance: [
        provenance({
          groupKind: "ai_discovery",
          mechanismBasis: "complete",
          verification: {
            proposed: 6,
            confirmed: 4,
            unsupported: 1,
            inconclusive: 1,
            unchecked: 0,
          },
        }),
      ],
    });
    openDetails();
    expect(
      screen.getByTestId("unified-finding-verification"),
    ).toHaveTextContent(
      "Verified 4 of 6 proposed trials (1 did not show it, 1 could not be verified); only verified trials are counted.",
    );
  });
  it("prints nothing about verification when every proposed trial was confirmed or the backend sent none", () => {
    renderPanel({
      mode: "ai",
      provenance: [
        provenance({
          groupKind: "ai_discovery",
          verification: {
            proposed: 6,
            confirmed: 6,
            unsupported: 0,
            inconclusive: 0,
            unchecked: 0,
          },
        }),
      ],
    });
    openDetails();
    expect(screen.queryByTestId("unified-finding-verification")).toBeNull();
    expect(screen.queryByTestId("unified-finding-caveat")).toBeNull();
  });
  it("names the measured error groups a consolidated finding was built from", () => {
    const merged = finding({
      id: "merged:mechanism:1",
      title: "6 of 40 trials failed to save the server.",
      observed: "6 of 40 trials failed to save the server.",
      affected: { count: 6, total: 40, unit: "iterations" },
    });
    renderPanel({
      mode: "ai",
      findings: [merged],
      provenance: [
        provenance({
          candidateId: merged.id,
          groupKind: "ai_discovery",
          sourceCandidateIds: ["rf_src1", "rf_src2"],
        }),
      ],
      snapshot: snapshot({
        deterministicFindings: [
          finding({
            id: "rf_src1",
            observed:
              "`save_project_servers` returned an error in 3 of 40 iterations.",
          }),
          finding({
            id: "rf_src2",
            observed:
              "`save_project_servers` rejected the arguments in 3 of 40 iterations.",
          }),
        ],
      }),
    });
    openDetails();
    const sources = screen.getByTestId("unified-finding-sources");
    expect(sources).toHaveTextContent("Consolidated from 2 error groups");
    expect(sources).toHaveTextContent("returned an error in 3 of 40");
    expect(sources).toHaveTextContent("rejected the arguments in 3 of 40");
  });
  it("shows no consolidation section on a finding that was not merged", () => {
    renderPanel({ mode: "ai" });
    openDetails();
    expect(screen.queryByTestId("unified-finding-sources")).toBeNull();
  });
  it("does not print a coverage footer under the findings panel", () => {
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
      screen.queryByTestId("unified-findings-coverage-summary"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Coverage details" }),
    ).toBeNull();
    expect(screen.getByTestId("unified-findings-panel")).not.toHaveTextContent(
      "Evidence covers",
    );
    expect(
      screen.getByTestId("unified-findings-exclusion-summary"),
    ).toHaveTextContent("6 iterations without a verified stage chain");
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
            observed: "deterministic",
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
      screen.queryByTestId("unified-findings-coverage-summary"),
    ).toBeNull();
    expect(screen.queryByText("AI explanation")).toBeNull();
  });
});

describe("automatic analysis failure note", () => {
  it("explains analyzer version changes", () => {
    renderPanel({ analysisFailure: { errorCode: "superseded" } });
    expect(screen.getByTestId("unified-findings-analysis-failed")).toHaveTextContent(
      "AI analysis did not complete. The analyzer was updated during analysis.",
    );
  });
  it.each(["evidence_changed", "unknown_failure", undefined])(
    "keeps findings visible for %s",
    (errorCode) => {
      renderPanel({ analysisFailure: { errorCode } });
      const note = screen.getByTestId("unified-findings-analysis-failed");
      expect(note).toHaveTextContent("AI analysis did not complete.");
      expect(note).not.toHaveAttribute("role", "alert");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByTestId("unified-findings-list")).toBeVisible();
      if (errorCode === "unknown_failure") {
        expect(note.textContent).toBe("AI analysis did not complete.");
      }
    },
  );
});
