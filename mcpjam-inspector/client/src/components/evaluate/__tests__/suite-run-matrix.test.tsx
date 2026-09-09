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
    hosts: [{ hostId: "claude", name: "Claude", modelId: "sonnet" }],
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
  ).toMatchObject({
    hostId: "claude",
    modelId: "opus",
    serverAttachmentId: "servers",
    skillSelection: null,
  });
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
      { iterationOverride: 3, ephemeralEnvironment: true },
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
      { iterationOverride: 3 },
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
