import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { panel } = vi.hoisted(() => ({ panel: vi.fn() }));

vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock(
  "@/components/shared/actionable-insights/use-insights-envelope",
  () => ({ useInsightsEnvelope: () => undefined }),
);
vi.mock("@/components/shared/actionable-insights/use-unified-findings", () => ({
  useUnifiedFindings: () => ({
    findings: [
      { id: "mine", evidence: [{ kind: "transcript", iterationId: "a1" }] },
      { id: "other", evidence: [{ kind: "transcript", iterationId: "z9" }] },
      { id: "session", evidence: [{ kind: "feedback", sessionId: "s" }] },
    ],
    provenance: [],
    mode: "deterministic",
    analyze: {},
    build: {},
    analysisFailure: null,
    backendUnavailableNote: null,
  }),
}));
vi.mock(
  "@/components/shared/actionable-insights/unified-findings-panel",
  () => ({
    UnifiedFindingsPanel: (props: { findings: { id: string }[] }) => {
      panel(props.findings.map((finding) => finding.id));
      return null;
    },
  }),
);

import { UnifiedFindingsSection } from "../../unified-findings-section";

const generation = {
  pending: false,
  failedGeneration: false,
  error: null,
  unavailable: false,
  canRequest: false,
  requestInsight: vi.fn(),
};

describe("UnifiedFindingsSection on a test run", () => {
  it("keeps only findings that cite one of the case's iterations", () => {
    render(
      <UnifiedFindingsSection
        suiteRunId="run"
        generation={generation}
        onlyIterationIds={new Set(["a1", "a2"])}
      />,
    );
    expect(panel).toHaveBeenLastCalledWith(["mine"]);
  });

  it("keeps every finding on the suite run", () => {
    render(<UnifiedFindingsSection suiteRunId="run" generation={generation} />);
    expect(panel).toHaveBeenLastCalledWith(["mine", "other", "session"]);
  });
});
