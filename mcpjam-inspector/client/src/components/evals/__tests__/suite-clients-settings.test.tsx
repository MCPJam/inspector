import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  SuiteClientsSettings,
  planSuiteClients,
} from "../suite-clients-settings";
import type { EvalSuite } from "../types";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  save: vi.fn(),
  error: vi.fn(),
  environments: [] as ProjectEnvironmentView[],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => mocks.save,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [], isLoading: false }),
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mocks.environments,
  useEnsureAdhocEnvironments: () => mocks.ensure,
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({ capable: true, pending: false }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("../../evaluate/eval-target-matrix", () => ({
  EvalTargetMatrix: ({
    modelSelectionsByHost,
    onModelSelectionChange,
    disabled,
  }: any) => (
    <div>
      <span>{modelSelectionsByHost.chat.explicitModelIds.join(",")}</span>
      <button
        disabled={disabled}
        onClick={() =>
          onModelSelectionChange("chat", {
            includeClientDefaults: false,
            explicitModelIds: ["new-model"],
          })
        }
      >
        Change model
      </button>
    </div>
  ),
}));
const suite = {
  _id: "suite",
  name: "Suite",
  environmentIds: ["chat-env", "cursor-env"],
} as EvalSuite;
const envs = [
  {
    environmentId: "chat-env",
    hostId: "chat",
    modelId: "gpt",
    serverAttachmentId: "chat-servers",
    skillSelection: { mode: "explicit", skillIds: ["skill"] },
    computerEnvironmentId: "image",
    secretSelection: { mode: "explicit", secretIds: ["secret"] },
  },
  {
    environmentId: "cursor-env",
    hostId: "cursor",
    modelId: "sonnet",
    serverAttachmentId: "cursor-servers",
    pluginVersionIds: ["pin"],
  },
] as ProjectEnvironmentView[];
const selections = {
  chat: { includeClientDefaults: false, explicitModelIds: ["new-model"] },
  cursor: { includeClientDefaults: false, explicitModelIds: ["sonnet"] },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.environments = envs;
  mocks.ensure.mockResolvedValue([
    { environment: { environmentId: "new-env" } },
  ]);
  mocks.save.mockResolvedValue({});
});
it("preserves unrelated clients exactly and carries the edited client's configuration", () => {
  expect(planSuiteClients(suite, envs, selections)).toEqual([
    {
      stack: {
        hostId: "chat",
        modelId: "new-model",
        serverAttachmentId: "chat-servers",
        skillSelection: envs[0].skillSelection,
        secretSelection: envs[0].secretSelection,
        computerEnvironmentId: "image",
      },
    },
    { environmentId: "cursor-env" },
  ]);
});
it("keeps multiple server configurations when adding a model to one client", () => {
  const extra = {
    ...envs[0],
    environmentId: "extra",
    serverAttachmentId: "other",
  };
  const result = planSuiteClients(
    { ...suite, environmentIds: [...suite.environmentIds!, "extra"] },
    [...envs, extra],
    selections,
  );
  expect(
    result.flatMap((item) => item.stack?.serverAttachmentId ?? []),
  ).toEqual(["chat-servers", "other"]);
});
it("preserves row settings when replacing a client", () => {
  const plan = planSuiteClients(
    suite,
    envs,
    { replacement: selections.chat },
    { replacement: "chat" },
  );
  expect(plan[0].stack).toMatchObject({
    hostId: "replacement",
    serverAttachmentId: "chat-servers",
    computerEnvironmentId: "image",
  });
});
it("loads saved model choices and persists only after an edit", async () => {
  render(<SuiteClientsSettings suite={suite} projectId="project" />);
  expect(screen.getByText("gpt")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Change model"));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      suiteId: "suite",
      environmentIds: ["new-env", "cursor-env"],
    }),
  );
  expect(mocks.ensure.mock.calls[0][0].stacks).toHaveLength(1);
});
it("restores the previous selection after a failed save", async () => {
  mocks.save.mockRejectedValue(new Error("Save failed"));
  render(<SuiteClientsSettings suite={suite} projectId="project" />);
  fireEvent.click(screen.getByText("Change model"));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(screen.getByText("gpt")).toBeTruthy();
});
it("blocks writes when an existing attachment is unresolved", () => {
  mocks.environments = [envs[0]];
  render(<SuiteClientsSettings suite={suite} projectId="project" />);
  expect(screen.getByRole("button", { name: "Change model" })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
});
