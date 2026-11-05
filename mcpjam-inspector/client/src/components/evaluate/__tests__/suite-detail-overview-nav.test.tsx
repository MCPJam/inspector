import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteDetailOverview } from "../suite-detail-overview";
import { metricsByRunFromIterations } from "../../evals/run-metrics";
import type { EvalCase, EvalSuite } from "../../evals/types";

const flag = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("../nav/use-evaluate-nav-enabled", () => ({
  useEvaluateNavEnabled: () => flag.value,
}));
vi.mock("../create-suite-navigation", async (original) => ({
  ...(await original<object>()),
  navigatePlaygroundEvalsRoute: navigate,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "checkout-flow",
  description: "",
  configRevision: "1",
  environment: { servers: ["payments"] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u1",
  title: "Pay invoice",
  query: "Pay the open invoice",
  models: [{ model: "gpt-5-nano", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
};

function renderOverview(props: { readOnlyConfig?: boolean } = {}) {
  return renderWithProviders(
    <SuiteDetailOverview
      suite={suite}
      cases={[testCase]}
      runs={[]}
      runsLoading={false}
      metricsByRun={metricsByRunFromIterations([])}
      hostNamesById={new Map()}
      onRerun={vi.fn()}
      onEditSuite={vi.fn()}
      onSetupSdk={vi.fn()}
      onEditCases={vi.fn()}
      onRunClick={vi.fn()}
      onTestCaseClick={vi.fn()}
      rerunningSuiteId={null}
      {...props}
    />,
  );
}

describe("SuiteDetailOverview with evaluate-nav-enabled", () => {
  beforeEach(() => {
    navigate.mockReset();
  });

  it("shows results only, with Export as SDK, Suite settings and Run", async () => {
    flag.value = true;
    renderOverview();

    expect(screen.queryByTestId("suite-detail-test-cases")).toBeNull();
    expect(screen.getByRole("button", { name: /Export as SDK/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(screen.queryByText("Configure suite evaluators")).toBeNull();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Suite settings/ }));
    expect(navigate).toHaveBeenCalledWith({
      type: "suite-settings",
      suiteId: "suite-1",
      tab: "settings",
    });
  });

  it("offers no Suite settings on a read-only suite", () => {
    flag.value = true;
    renderOverview({ readOnlyConfig: true });
    expect(screen.queryByRole("button", { name: /Suite settings/ })).toBeNull();
  });

  it.each([false, undefined])(
    "keeps today's page when the flag is %s",
    (value) => {
      flag.value = value;
      renderOverview();

      expect(screen.getByTestId("suite-detail-test-cases")).toBeTruthy();
      expect(screen.getByRole("button", { name: /Setup SDK/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Setup Run" })).toBeTruthy();
      expect(screen.getByText("Configure suite evaluators")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Suite settings/ }),
      ).toBeNull();
    },
  );
});
