import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SuiteRunReview } from "../suite-run-review";
import { planRunMatrix, seedRunMatrix } from "../suite-run-matrix";
import type { EvalSuite, EvalCase } from "../../evals/types";
const { ensure, query } = vi.hoisted(() => ({
  ensure: vi.fn(),
  query: vi.fn(async () => ({ ephemeralEnvironmentLaunch: true })),
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({ query }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      { hostId: "claude", name: "Claude", modelId: "sonnet" },
      { hostId: "mcpjam", name: "MCPJam", modelId: "" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useEnsureAdhocEnvironments: () => ensure,
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({ capable: true, pending: false }),
}));
vi.mock("../eval-target-matrix", () => ({
  EvalTargetMatrix: ({
    onModelSelectionChange,
    disabled,
  }: {
    onModelSelectionChange: (id: string, value: unknown) => void;
    disabled: boolean;
  }) => (
    <button
      disabled={disabled}
      onClick={() =>
        onModelSelectionChange("claude", {
          includeClientDefaults: false,
          explicitModelIds: ["opus"],
        })
      }
    >
      Change model
    </button>
  ),
}));
const suite = {
  _id: "suite",
  name: "Checkout",
  environmentIds: ["env"],
  serverAttachmentId: "servers",
  minIterations: 2,
} as EvalSuite;
const environments = [
  {
    environmentId: "env",
    hostId: "claude",
    modelId: "sonnet",
    serverAttachmentId: "servers",
    skillSelection: null,
  },
];
const cases = [{ _id: "case", runs: 1, models: [] }] as unknown as EvalCase[];
it("seeds model overrides and preserves existing environment ids", () => {
  const selection = seedRunMatrix(suite, environments);
  expect(selection).toEqual({
    claude: { includeClientDefaults: false, explicitModelIds: ["sonnet"] },
  });
  expect(planRunMatrix(suite, environments, selection)[0].environmentId).toBe(
    "env",
  );
});
it("keeps inherited models and preserves server scope for a new model", () => {
  expect(
    seedRunMatrix(suite, [{ ...environments[0], modelId: undefined }]).claude
      .includeClientDefaults,
  ).toBe(true);
  expect(
    planRunMatrix(suite, environments, {
      claude: { includeClientDefaults: false, explicitModelIds: ["opus"] },
    })[0].stack,
  ).toEqual({
    hostId: "claude",
    modelId: "opus",
    serverAttachmentId: "servers",
  });
});

it("never derives a new cell's servers from the suite's legacy group", () => {
  // The environment has no group; the suite's legacy field does. An
  // environment suite does not read that field, so copying it would be a
  // guess — the cell must be refused instead.
  const [cell] = planRunMatrix(
    { ...suite, serverAttachmentId: "legacy-group" },
    [{ ...environments[0], serverAttachmentId: undefined }],
    { claude: { includeClientDefaults: false, explicitModelIds: ["opus"] } },
  );
  expect(cell.stack).not.toHaveProperty("serverAttachmentId");
  expect(cell.missingGroup).toBe(true);
});

it("blocks a new cell when the client's setups disagree", () => {
  const plan = planRunMatrix(
    { ...suite, environmentIds: ["env", "env-2"] },
    [
      environments[0],
      { ...environments[0], environmentId: "env-2", serverAttachmentId: "b" },
    ],
    { claude: { includeClientDefaults: false, explicitModelIds: ["opus"] } },
  );
  expect(plan).toHaveLength(1);
  expect(plan[0].blocked).toMatch(/setups differ/);
});

it("blocks a new cell whose template carries what a one-run change can't copy", () => {
  const [cell] = planRunMatrix(
    suite,
    [
      {
        ...environments[0],
        secretSelection: { mode: "explicit", secretIds: ["secret"] },
      },
    ],
    { claude: { includeClientDefaults: false, explicitModelIds: ["opus"] } },
  );
  expect(cell.blocked).toMatch(/grants project secrets/);
});
it("resolves changed combinations only at launch without modifying the suite", async () => {
  ensure.mockResolvedValue([{ environment: { environmentId: "new-env" } }]);
  const onStart = vi.fn();
  render(
    <SuiteRunReview
      projectId="project"
      suite={suite}
      cases={cases}
      environments={environments}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change model" }));
  expect(ensure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ environmentIds: ["new-env"] }),
      { iterationOverride: 5, ephemeralEnvironment: true },
    ),
  );
  expect(ensure).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "project",
      stacks: [
        expect.objectContaining({
          modelId: "opus",
          serverAttachmentId: "servers",
        }),
      ],
    }),
  );
  expect(suite.environmentIds).toEqual(["env"]);
});

beforeEach(() => {
  ensure.mockReset();
  query.mockReset();
  query.mockResolvedValue({ ephemeralEnvironmentLaunch: true });
});

it("launches saved pairings without a temporary-environment flag or capability probe", async () => {
  const onStart = vi.fn();
  render(
    <SuiteRunReview
      projectId="project"
      suite={suite}
      cases={cases}
      environments={environments}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ environmentIds: ["env"] }),
      { iterationOverride: 5 },
    ),
  );
  expect(ensure).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it("keeps unsupported temporary pairings out of launch requests", async () => {
  query.mockResolvedValue({ ephemeralEnvironmentLaunch: false });
  const onStart = vi.fn();
  render(
    <SuiteRunReview
      projectId="project"
      suite={suite}
      cases={cases}
      environments={environments}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change model" }));
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  expect(
    await screen.findByText(/does not support one-run client\/model changes/),
  ).toBeVisible();
  expect(ensure).not.toHaveBeenCalled();
  expect(onStart).not.toHaveBeenCalled();
});

it("blocks a client default when the client has no model", () => {
  const onStart = vi.fn();
  render(
    <SuiteRunReview
      projectId="project"
      suite={{ ...suite, environmentIds: ["env-blank"] }}
      cases={cases}
      environments={[
        {
          ...environments[0],
          environmentId: "env-blank",
          hostId: "mcpjam",
          modelId: undefined,
        },
      ]}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByText("Choose at least one client and model."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
});

it("blocks Start when an attached environment has no server group", () => {
  const onStart = vi.fn();
  render(
    <SuiteRunReview
      projectId="project"
      suite={suite}
      cases={cases}
      environments={[{ ...environments[0], serverAttachmentId: undefined }]}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText(/would connect no servers/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
});

it("launches a suite without environments through its own configuration", async () => {
  // No environments are composed from the legacy fields: the runtime knows
  // where a legacy suite keeps its servers, this dialog does not.
  const onStart = vi.fn();
  const legacy = {
    ...suite,
    environmentIds: undefined,
    hostAttachments: [
      {
        namedHostId: "claude",
        enabledOptionalServerIds: [],
        hostName: "Claude",
        resolvedServerNames: [],
      },
    ],
  } as unknown as EvalSuite;
  render(
    <SuiteRunReview
      projectId="project"
      suite={legacy}
      cases={cases}
      environments={[]}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Change model" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  const [launched, options] = onStart.mock.calls[0];
  expect(launched.environmentIds).toBeUndefined();
  expect(options).not.toHaveProperty("ephemeralEnvironment");
  expect(ensure).not.toHaveBeenCalled();
});
