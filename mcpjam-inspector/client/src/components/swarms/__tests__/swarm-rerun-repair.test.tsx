import type { ModelDefinition } from "@/shared/types";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SwarmRerunRepairDialog,
  useSwarmRerunRepair,
  type RerunGoal,
} from "../swarm-rerun-repair";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  resolve: vi.fn(),
  models: new Array<ModelDefinition>(),
}));
vi.mock("convex/react", () => ({ useConvex: () => mocks }));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: mocks.models,
    onAddProvider: null,
  }),
}));
vi.mock("@/components/environment-composer/use-composer-resolver", () => ({
  useComposerResolver: () => mocks.resolve,
}));
vi.mock("@/components/environment-composer/environment-composer", () => ({
  SWARM_COMPOSER_SLOTS: [],
  EnvironmentComposer: ({
    value,
    onChange,
  }: {
    value: object;
    onChange: (next: object) => void;
  }) => (
    <button onClick={() => onChange({ ...value, customized: true })}>
      Choose organization target
    </button>
  ),
}));
vi.mock("../new-swarm-judge-row", () => ({
  NewSwarmJudgeRow: () => <div>Judge picker</div>,
}));
vi.mock("@/components/chat-v2/chat-input/model-selector", () => ({
  ModelSelector: ({
    currentModel,
    availableModels,
    onModelChange,
  }: {
    currentModel: ModelDefinition;
    availableModels: ModelDefinition[];
    onModelChange: (model: ModelDefinition) => void;
  }) => (
    <div>
      <span>{currentModel.name}</span>
      <button onClick={() => onModelChange(availableModels[1])}>
        Choose second connection
      </button>
    </div>
  ),
}));
const goal: RerunGoal = {
  runId: "run-old",
  journeyRefId: "journey-old",
  name: "Legacy swarm",
  updatedAt: 1,
  hostIds: ["host-old"],
  config: {},
  problems: [
    {
      dependency: "target",
      label: "Hosted Haiku",
      reason: "Choose an organization model.",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.models = [];
  mocks.query.mockResolvedValue([goal]);
  mocks.resolve.mockResolvedValue({ environmentIds: ["env-org"], skipped: [] });
});

it("checks every goal before allowing any launch and cancels without saving", async () => {
  const { result } = renderHook(() => useSwarmRerunRepair("project"));
  let prepared: Promise<string[] | null>;
  await act(async () => {
    prepared = result.current.prepare(["run-old", "run-other"]);
  });
  expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
    projectId: "project",
    runIds: ["run-old", "run-other"],
  });
  render(result.current.dialog);
  expect(screen.getByText("Hosted Haiku")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByText("Cancel")));
  expect(await prepared!).toBeNull();
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
});

it("saves only an explicit pick and rechecks the persisted configuration", async () => {
  mocks.query
    .mockResolvedValueOnce([goal])
    .mockResolvedValueOnce([
      { ...goal, journeyRefId: "journey-repaired", problems: [] },
    ]);
  const { result } = renderHook(() => useSwarmRerunRepair("project"));
  let prepared: Promise<string[] | null>;
  await act(async () => {
    prepared = result.current.prepare(["run-old"]);
  });
  render(result.current.dialog);
  expect(
    screen.getByText("Save replacements").closest("button")?.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByText("Choose organization target"));
  fireEvent.click(screen.getByText("Save replacements"));
  await waitFor(() =>
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      runId: "run-old",
      journeyRefId: "journey-old",
      updatedAt: 1,
      environmentIds: ["env-org"],
    }),
  );
  expect(await prepared!).toEqual(["journey-repaired"]);
});

it("leaves already qualifying swarms on the normal launch path", async () => {
  mocks.query.mockResolvedValue([{ ...goal, problems: [] }]);
  const { result } = renderHook(() => useSwarmRerunRepair("project"));
  expect(await result.current.prepare(["run-old"])).toEqual(["journey-old"]);
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(result.current.dialog).toBeNull();
});

it("keeps the repair open after a rejected save", async () => {
  mocks.mutation.mockRejectedValue(
    new Error("This connection is no longer available."),
  );
  const onDone = vi.fn();
  render(
    <SwarmRerunRepairDialog projectId="project" goal={goal} onDone={onDone} />,
  );
  fireEvent.click(screen.getByText("Choose organization target"));
  fireEvent.click(screen.getByText("Save replacements"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This connection is no longer available.",
  );
  expect(onDone).not.toHaveBeenCalled();
});

it("keeps the simulated user model tied to the explicitly picked connection", async () => {
  mocks.models = [
    {
      id: "gpt-4o",
      name: "Connection A",
      provider: "openai",
      hosted: false,
      orgProvider: { providerKey: "openai", id: "connection-a" },
    },
    {
      id: "gpt-4o",
      name: "Connection B",
      provider: "openai",
      hosted: false,
      orgProvider: { providerKey: "openai", id: "connection-b" },
    },
  ];
  mocks.mutation.mockResolvedValue("repaired");
  render(
    <SwarmRerunRepairDialog
      projectId="project"
      goal={{
        ...goal,
        problems: [
          {
            dependency: "persona",
            label: "Simulated user",
            reason: "Choose an organization model.",
          },
        ],
      }}
      onDone={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Choose second connection"));
  expect(screen.getByText("Connection B")).toBeTruthy();
  fireEvent.click(screen.getByText("Save replacements"));
  await waitFor(() =>
    expect(mocks.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        personaSelection: expect.objectContaining({
          modelId: "openai/gpt-4o",
          connectionRef: { kind: "orgProvider", id: "connection-b" },
        }),
      }),
    ),
  );
});
