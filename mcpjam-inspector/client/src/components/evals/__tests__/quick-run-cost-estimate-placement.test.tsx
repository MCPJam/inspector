import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONTRACT: the per-case credit estimate must appear beside a quick-run control
 * ONLY where that control will actually launch a run. Quick-run refuses to run
 * (toast-and-return) for environment suites, cases with no models, and model-free
 * render checks — an estimate next to a control that never spends is worse than
 * no estimate at all.
 *
 * Also asserts the flag gate at the placement level: with the flag off, the
 * rows render no hint and no estimate query is dispatched.
 */

const queryCalls: Array<{ name: string; args: unknown }> = [];

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: (name: string, args: unknown) => {
      queryCalls.push({ name, args });
      return Promise.resolve(undefined);
    },
  }),
  useQuery: () => undefined,
  usePaginatedQuery: () => ({ results: [], status: "Exhausted" }),
  useMutation: () => vi.fn(),
}));

let flagEnabled: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagEnabled,
}));

import { TestCasesOverview } from "../test-cases-overview";
import { RUN_COST_ESTIMATE_QUERIES } from "@/hooks/use-run-cost-estimate";

const promptCase = {
  _id: "case-prompt",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "Prompt case",
  query: "Do the thing",
  models: [{ model: "gpt-5-mini", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
  steps: [{ id: "s1", kind: "prompt", prompt: "Do the thing" }],
} as any;

const noModelsCase = {
  ...promptCase,
  _id: "case-no-models",
  title: "No models",
  models: [],
} as any;

const renderCheckCase = {
  ...promptCase,
  _id: "case-render",
  title: "Render check",
  models: [],
  query: "",
  steps: [
    {
      id: "s1",
      kind: "toolCall",
      serverName: "srv",
      toolName: "render",
      arguments: {},
    },
  ],
} as any;

const baseSuite = {
  _id: "suite-1",
  name: "Suite",
  environment: { servers: ["asana"] },
} as any;

function renderOverview(
  cases: any[],
  suite: any = baseSuite,
  extra: Record<string, unknown> = {},
) {
  return render(
    <TestCasesOverview
      suite={suite}
      cases={cases}
      allIterations={[]}
      runsViewMode={"cases" as any}
      onViewModeChange={vi.fn()}
      onTestCaseClick={vi.fn()}
      runTrendData={[]}
      modelStats={[]}
      runsLoading={false}
      onRunTestCase={vi.fn()}
      connectedServerNames={new Set(["asana"])}
      {...extra}
    />,
  );
}

beforeEach(() => {
  queryCalls.length = 0;
  flagEnabled = true;
});

afterEach(() => {
  cleanup();
});

describe("per-case credit estimate placement", () => {
  it("renders one hint for a runnable prompt case", () => {
    renderOverview([promptCase]);
    expect(screen.getAllByTestId("run-cost-estimate-hint")).toHaveLength(1);
  });

  it("renders no hint when the flag is off, and dispatches no query", async () => {
    flagEnabled = false;
    renderOverview([promptCase]);
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
    await Promise.resolve();
    expect(
      queryCalls.filter(
        (call) => call.name === RUN_COST_ESTIMATE_QUERIES.quickCase,
      ),
    ).toHaveLength(0);
  });

  it("renders no hint for a case with no models (quick-run toasts instead)", () => {
    renderOverview([noModelsCase]);
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
  });

  it("renders no hint for a model-free render check", () => {
    renderOverview([renderCheckCase]);
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
  });

  it("renders no hint on an environment suite (quick-run routes to Run all)", () => {
    renderOverview([promptCase], {
      ...baseSuite,
      environmentIds: ["env-1"],
    });
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
  });

  it("renders no hint when the suite has no servers attached", () => {
    // Quick-run toasts "Attach a client to this suite before running it." and
    // returns — the same permanent refusal as the other suppressed cases, and
    // the condition `TestCaseListSidebar` already gates on.
    renderOverview([promptCase], {
      ...baseSuite,
      environment: { servers: [] },
    });
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
  });

  it("still renders the hint when servers are merely disconnected", () => {
    // That state resolves by connecting — the row's tooltip says "Connect and
    // run." — so the estimate is exactly right for the run that follows and
    // must NOT be suppressed.
    renderOverview([promptCase], baseSuite, {
      connectedServerNames: new Set<string>(),
    });
    expect(screen.getAllByTestId("run-cost-estimate-hint")).toHaveLength(1);
  });

  it("renders no hint when the Run control itself is not offered", () => {
    render(
      <TestCasesOverview
        suite={baseSuite}
        cases={[promptCase]}
        allIterations={[]}
        runsViewMode={"cases" as any}
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
        connectedServerNames={new Set(["asana"])}
      />,
    );
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
  });

  it("shows a hint per runnable case and skips the unrunnable ones", () => {
    renderOverview([promptCase, noModelsCase, renderCheckCase]);
    expect(screen.getAllByTestId("run-cost-estimate-hint")).toHaveLength(1);
  });
});
