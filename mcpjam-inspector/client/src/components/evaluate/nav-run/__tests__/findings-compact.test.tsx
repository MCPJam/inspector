import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import type { ActionableFinding } from "@/lib/insights-envelope-api";
import type { UnifiedFindingsState } from "@/components/shared/actionable-insights/use-unified-findings";
import type { EvalIteration } from "../../../evals/types";
import { UnifiedFindingsSection } from "../../unified-findings-section";
import { FindingsCompactList } from "../findings-compact";

const state = vi.hoisted(() => {
  const holder: { current: Partial<UnifiedFindingsState> } = { current: {} };
  return holder;
});
vi.mock(
  "@/components/shared/actionable-insights/use-insights-envelope",
  () => ({
    useInsightsEnvelope: () => undefined,
  }),
);
vi.mock("@/components/shared/actionable-insights/use-unified-findings", () => ({
  useUnifiedFindings: () => state.current,
}));
vi.mock(
  "@/components/shared/actionable-insights/unified-findings-panel",
  () => ({
    UnifiedFindingsPanel: () => <div data-testid="unified-findings-panel" />,
  }),
);

function finding(
  overrides: Partial<ActionableFinding> = {},
): ActionableFinding {
  return {
    id: "rf_1",
    signalFingerprint: "sha256:fp1",
    title: "Selection",
    category: "agent_behavior",
    attribution: "unknown",
    actionTarget: "investigate",
    actionability: "investigate",
    severity: "medium",
    confidence: "low",
    observed:
      "3 of 24 iterations broke at Selection: an expected tool call was never made.",
    recommendation:
      "Open the exemplar sessions and identify the mechanism before changing anything.",
    acceptanceCriteria: [],
    affected: { count: 3, total: 24, unit: "iterations" },
    evidence: [{ iterationId: "it-1", kind: "transcript", excerpt: "…" }],
    ...overrides,
  };
}

describe("FindingsCompactList", () => {
  it("shows each finding with How to fix, Copy fix prompt and Open iteration", async () => {
    const onOpenIteration = vi.fn();
    renderWithProviders(
      <FindingsCompactList
        findings={[finding()]}
        scope="across 2 models"
        heldIterationIds={new Set(["it-1"])}
        onOpenIteration={onOpenIteration}
      />,
    );
    expect(screen.getByText("1 across 2 models")).toBeVisible();
    expect(screen.getByRole("button", { name: "About Findings" })).toBeTruthy();
    expect(screen.getByText(/broke at Selection/)).toBeVisible();
    expect(screen.getByText("How to fix:")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy fix prompt" })).toHaveClass(
      "h-7",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open iteration" }));
    expect(onOpenIteration).toHaveBeenCalledWith("it-1");
  });

  it("offers no Open iteration for an iteration this page does not hold", () => {
    renderWithProviders(
      <FindingsCompactList
        findings={[finding()]}
        scope=""
        heldIterationIds={new Set(["other"])}
        onOpenIteration={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open iteration" })).toBeNull();
  });

  it("says when nothing was found", () => {
    renderWithProviders(
      <FindingsCompactList
        findings={[]}
        scope="for MCPJam · gpt-5-mini"
        heldIterationIds={new Set()}
      />,
    );
    expect(
      screen.getByText("No issue found in the recorded assertions."),
    ).toBeVisible();
    expect(screen.getByText("for MCPJam · gpt-5-mini")).toBeVisible();
  });
});

describe("UnifiedFindingsSection compact", () => {
  const idle = {
    available: false,
    pending: false,
    error: null,
    onRun: vi.fn(),
  };
  function built(overrides: Partial<UnifiedFindingsState> = {}) {
    return {
      envelope: null,
      experiment: { snapshot: { deterministicFindings: [] } },
      mode: "deterministic",
      findings: [finding()],
      provenance: [],
      analyze: {
        available: false,
        pending: false,
        error: null,
        onRun: vi.fn(),
      },
      analysisFailure: null,
      build: idle,
      enrich: idle,
      backendUnavailableNote: null,
      ...overrides,
    };
  }
  const generation = {
    pending: false,
    failedGeneration: false,
    error: null,
    unavailable: false,
    canRequest: false,
    requestInsight: vi.fn(),
  };
  const iterations: EvalIteration[] = [];

  beforeEach(() => {
    state.current = {};
  });

  it("renders the compact list once findings are built", () => {
    state.current = built();
    renderWithProviders(
      <UnifiedFindingsSection
        suiteRunId="run-1"
        iterations={iterations}
        generation={generation}
        variant="compact"
        scopeLabel="across 2 models"
      />,
    );
    expect(screen.getByTestId("nav-findings")).toHaveTextContent(
      "1 across 2 models",
    );
    expect(screen.queryByTestId("unified-findings-panel")).toBeNull();
  });

  it.each([
    ["not built", { experiment: undefined }],
    ["building", { build: { ...idle, pending: true } }],
    ["failed", { build: { ...idle, error: "boom" } }],
  ])("keeps today's panel while %s", (_, overrides) => {
    state.current = built(overrides);
    renderWithProviders(
      <UnifiedFindingsSection
        suiteRunId="run-1"
        iterations={iterations}
        generation={generation}
        variant="compact"
      />,
    );
    expect(screen.getByTestId("unified-findings-panel")).toBeTruthy();
    expect(screen.queryByTestId("nav-findings")).toBeNull();
  });
});
