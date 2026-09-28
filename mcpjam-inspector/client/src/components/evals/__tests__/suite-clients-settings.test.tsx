import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousSuiteTemplateError,
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
  capabilities: null as { environmentDerivation?: boolean } | null,
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
vi.mock("@/hooks/use-environment-capabilities", () => ({
  useEnvironmentCapabilities: () => mocks.capabilities,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: ({
    value,
    onChange,
    emptyTriggerLabel,
    disabled,
  }: {
    value: string | null;
    onChange: (id: string) => void;
    emptyTriggerLabel?: string;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={() => onChange("picked-group")}>
      {value ?? emptyTriggerLabel}
    </button>
  ),
}));
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
    serverAttachmentId: "servers",
    skillSelection: { mode: "explicit", skillIds: ["skill"] },
    computerEnvironmentId: "image",
  },
  {
    environmentId: "cursor-env",
    hostId: "cursor",
    modelId: "sonnet",
    serverAttachmentId: "servers",
  },
] as ProjectEnvironmentView[];
const selections = {
  chat: { includeClientDefaults: false, explicitModelIds: ["new-model"] },
  cursor: { includeClientDefaults: false, explicitModelIds: ["sonnet"] },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.environments = envs;
  mocks.capabilities = null;
  mocks.ensure.mockResolvedValue([
    { environment: { environmentId: "new-env" } },
  ]);
  mocks.save.mockResolvedValue({});
});

describe("planSuiteClients", () => {
  it("reuses untouched clients by id and derives a new model from the client's setup", () => {
    expect(
      planSuiteClients(suite, envs, selections, { group: "servers" }),
    ).toEqual([
      {
        stack: {
          hostId: "chat",
          modelId: "new-model",
          serverAttachmentId: "servers",
          skillSelection: envs[0].skillSelection,
          computerEnvironmentId: "image",
        },
      },
      { environmentId: "cursor-env" },
    ]);
  });

  it("never takes a new client's group from the suite's legacy field", () => {
    // The incident: an environment suite does not read `serverAttachmentId`,
    // and copying it into a new client produced an environment with no group.
    const legacy = {
      ...suite,
      environmentIds: [],
      serverAttachmentId: "legacy-group",
    } as EvalSuite;
    expect(() =>
      planSuiteClients(legacy, [], {
        chat: { includeClientDefaults: true, explicitModelIds: [] },
      }),
    ).toThrow(/Pick a server group/);
    expect(
      planSuiteClients(
        legacy,
        [],
        { chat: { includeClientDefaults: true, explicitModelIds: [] } },
        { group: "picked" },
      ),
    ).toEqual([{ stack: { hostId: "chat", serverAttachmentId: "picked" } }]);
  });

  it("refuses to pick one of several different setups on a client", () => {
    const extra = {
      ...envs[0],
      environmentId: "extra",
      serverAttachmentId: "other",
    };
    expect(() =>
      planSuiteClients(
        { ...suite, environmentIds: [...suite.environmentIds!, "extra"] },
        [...envs, extra],
        selections,
      ),
    ).toThrow(/setups differ/);
  });

  it("keeps distinct existing setups untouched instead of collapsing them", () => {
    const extra = {
      ...envs[0],
      environmentId: "extra",
      serverAttachmentId: "other",
    };
    const plan = planSuiteClients(
      { ...suite, environmentIds: [...suite.environmentIds!, "extra"] },
      [...envs, extra],
      {
        chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
        cursor: selections.cursor,
      },
    );
    expect(plan).toEqual([
      { environmentId: "chat-env" },
      { environmentId: "extra" },
      { environmentId: "cursor-env" },
    ]);
  });

  it("gives a new client the shared setup, and refuses when clients disagree", () => {
    const plan = planSuiteClients(
      suite,
      [
        envs[0],
        {
          ...envs[1],
          skillSelection: envs[0].skillSelection,
          computerEnvironmentId: "image",
        },
      ],
      {
        ...selections,
        chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
        codex: { includeClientDefaults: true, explicitModelIds: [] },
      },
      { group: "servers" },
    );
    expect(plan.at(-1)).toEqual({
      stack: {
        hostId: "codex",
        serverAttachmentId: "servers",
        skillSelection: envs[0].skillSelection,
        computerEnvironmentId: "image",
      },
    });
    expect(() =>
      planSuiteClients(
        suite,
        [envs[0], { ...envs[1], serverAttachmentId: "elsewhere" }],
        {
          ...selections,
          chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
          codex: { includeClientDefaults: true, explicitModelIds: [] },
        },
      ),
    ).toThrow(/don't share one setup/);
  });

  it.each([
    ["plugin pins", { pluginVersionIds: ["pin"] }, /pins plugin versions/],
    [
      "server-skill pins",
      {
        serverSkillSelection: {
          mode: "explicit",
          serverSkillIds: ["server-skill"],
        },
      },
      /captured server skills/,
    ],
    [
      "secret grants",
      { secretSelection: { mode: "explicit", secretIds: ["secret"] } },
      /grants project secrets/,
    ],
  ])(
    "refuses to copy a template carrying %s instead of dropping them",
    (_label, extra, message) => {
      expect(() =>
        planSuiteClients(
          suite,
          [{ ...envs[0], ...extra } as ProjectEnvironmentView, envs[1]],
          selections,
          { group: "servers" },
        ),
      ).toThrow(message);
    },
  );

  it("still reuses a pinned environment unchanged", () => {
    const pinned = [
      { ...envs[0], pluginVersionIds: ["pin"] },
      envs[1],
    ] as ProjectEnvironmentView[];
    expect(
      planSuiteClients(
        suite,
        pinned,
        {
          chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
          cursor: selections.cursor,
        },
        { group: "servers" },
      ),
    ).toEqual([{ environmentId: "chat-env" }, { environmentId: "cursor-env" }]);
  });

  it("moves every environment to a newly picked group, keeping the rest", () => {
    expect(
      planSuiteClients(
        suite,
        envs,
        {
          chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
          cursor: selections.cursor,
        },
        { group: "new-group" },
      ),
    ).toEqual([
      {
        stack: {
          hostId: "chat",
          modelId: "gpt",
          serverAttachmentId: "new-group",
          skillSelection: envs[0].skillSelection,
          computerEnvironmentId: "image",
        },
      },
      {
        stack: {
          hostId: "cursor",
          modelId: "sonnet",
          serverAttachmentId: "new-group",
        },
      },
    ]);
  });

  it("refuses to keep a group-less environment, but allows a plugin-only one", () => {
    const groupless = [
      { ...envs[0], serverAttachmentId: undefined },
      envs[1],
    ] as ProjectEnvironmentView[];
    const keep = {
      chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
      cursor: selections.cursor,
    };
    expect(() => planSuiteClients(suite, groupless, keep)).toThrow(
      /no server group/,
    );
    expect(
      planSuiteClients(
        suite,
        [{ ...groupless[0], pluginVersionIds: ["pin"] }, envs[1]],
        keep,
      ),
    ).toEqual([{ environmentId: "chat-env" }, { environmentId: "cursor-env" }]);
  });

  it("carries a replaced client's setup to its replacement", () => {
    const plan = planSuiteClients(
      suite,
      envs,
      { replacement: selections.chat, cursor: selections.cursor },
      { group: "servers", sourceHosts: { replacement: "chat" } },
    );
    expect(plan[0].stack).toMatchObject({
      hostId: "replacement",
      serverAttachmentId: "servers",
      computerEnvironmentId: "image",
    });
  });
});

describe("SuiteClientsSettings", () => {
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
    expect(mocks.ensure.mock.calls[0][0].stacks).toEqual([
      expect.objectContaining({ serverAttachmentId: "servers" }),
    ]);
  });

  it("shows the shared group and moves every client when another is picked", async () => {
    mocks.ensure.mockResolvedValue([
      { environment: { environmentId: "chat-picked" } },
      { environment: { environmentId: "cursor-picked" } },
    ]);
    render(<SuiteClientsSettings suite={suite} projectId="project" />);
    fireEvent.click(screen.getByRole("button", { name: "servers" }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        suiteId: "suite",
        environmentIds: ["chat-picked", "cursor-picked"],
      }),
    );
    expect(
      mocks.ensure.mock.calls[0][0].stacks.map(
        (stack: { serverAttachmentId: string }) => stack.serverAttachmentId,
      ),
    ).toEqual(["picked-group", "picked-group"]);
  });

  it("says when the suite's clients have no server group", () => {
    mocks.environments = envs.map((env) => ({
      ...env,
      serverAttachmentId: undefined,
    }));
    render(<SuiteClientsSettings suite={suite} projectId="project" />);
    expect(screen.getByTestId("suite-clients-no-group-hint")).toBeTruthy();
    fireEvent.click(screen.getByText("Change model"));
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringMatching(/Pick a server group/),
    );
    expect(mocks.save).not.toHaveBeenCalled();
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
});

describe("planSuiteClients with backend derivation", () => {
  const pinned = [
    {
      ...envs[0],
      revision: 4,
      pluginVersionIds: ["pin"],
      secretSelection: { mode: "explicit", secretIds: ["secret"] },
    },
    { ...envs[1], revision: 2 },
  ] as ProjectEnvironmentView[];

  it("derives a new model from the stored setup instead of refusing its pins", () => {
    expect(
      planSuiteClients(suite, pinned, selections, {
        group: "servers",
        lossless: true,
      }),
    ).toEqual([
      {
        derive: {
          sourceEnvironmentId: "chat-env",
          expectedRevision: 4,
          overrides: {
            hostId: "chat",
            modelId: "new-model",
            serverAttachmentId: "servers",
          },
        },
      },
      { environmentId: "cursor-env" },
    ]);
  });

  it("moves each environment to a new group as a replacement of itself", () => {
    const plan = planSuiteClients(
      suite,
      pinned,
      {
        chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
        cursor: selections.cursor,
      },
      { group: "new-group", lossless: true },
    );
    expect(plan).toEqual([
      {
        derive: {
          sourceEnvironmentId: "chat-env",
          expectedRevision: 4,
          overrides: { serverAttachmentId: "new-group" },
          replaces: "chat-env",
        },
      },
      {
        derive: {
          sourceEnvironmentId: "cursor-env",
          expectedRevision: 2,
          overrides: { serverAttachmentId: "new-group" },
          replaces: "cursor-env",
        },
      },
    ]);
  });

  it("asks which setup to copy when the candidates differ, then derives from the pick", () => {
    const differing = [
      pinned[0],
      { ...pinned[1], serverAttachmentId: "elsewhere" },
    ] as ProjectEnvironmentView[];
    const newClient = {
      chat: { includeClientDefaults: false, explicitModelIds: ["gpt"] },
      cursor: selections.cursor,
      codex: { includeClientDefaults: true, explicitModelIds: [] },
    };
    let caught: unknown;
    try {
      planSuiteClients(suite, differing, newClient, { lossless: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AmbiguousSuiteTemplateError);
    expect(
      (caught as AmbiguousSuiteTemplateError).candidates.map(
        (row) => row.environmentId,
      ),
    ).toEqual(["chat-env", "cursor-env"]);

    const plan = planSuiteClients(suite, differing, newClient, {
      lossless: true,
      sourceEnvironmentId: "cursor-env",
    });
    expect(plan.at(-1)).toEqual({
      derive: {
        sourceEnvironmentId: "cursor-env",
        expectedRevision: 2,
        // A client-default cell clears the source's model.
        overrides: { hostId: "codex", modelId: null },
      },
    });
  });

  it("still refuses a derived environment that would have no servers", () => {
    const groupless = [
      { ...pinned[0], serverAttachmentId: undefined, pluginVersionIds: [] },
      { ...pinned[1], serverAttachmentId: undefined },
    ] as ProjectEnvironmentView[];
    expect(() =>
      planSuiteClients(suite, groupless, selections, { lossless: true }),
    ).toThrow(/Pick a server group/);
  });
});

describe("SuiteClientsSettings with backend derivation", () => {
  it("saves the edit in one derive-and-repoint call", async () => {
    mocks.capabilities = { environmentDerivation: true };
    mocks.environments = [
      { ...envs[0], revision: 3, pluginVersionIds: ["pin"] },
      { ...envs[1], revision: 1 },
    ] as ProjectEnvironmentView[];
    render(<SuiteClientsSettings suite={suite} projectId="project" />);
    fireEvent.click(screen.getByText("Change model"));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        suiteId: "suite",
        expectedEnvironmentIds: ["chat-env", "cursor-env"],
        targets: [
          {
            derive: {
              sourceEnvironmentId: "chat-env",
              expectedRevision: 3,
              overrides: {
                hostId: "chat",
                modelId: "new-model",
                serverAttachmentId: "servers",
              },
            },
          },
          { keep: "cursor-env" },
        ],
      }),
    );
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("asks which setup a new model copies when the client's setups differ", async () => {
    mocks.capabilities = { environmentDerivation: true };
    const twoChats = {
      ...suite,
      environmentIds: ["chat-env", "chat-other", "cursor-env"],
    } as EvalSuite;
    mocks.environments = [
      { ...envs[0], revision: 3 },
      {
        ...envs[0],
        environmentId: "chat-other",
        modelId: "gpt-mini",
        computerEnvironmentId: undefined,
        revision: 5,
      },
      { ...envs[1], revision: 1 },
    ] as ProjectEnvironmentView[];
    render(<SuiteClientsSettings suite={twoChats} projectId="project" />);
    fireEvent.click(screen.getByText("Change model"));
    expect(
      await screen.findByTestId("suite-clients-template-choice"),
    ).toBeTruthy();
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/gpt-mini/));
    fireEvent.click(screen.getByRole("button", { name: "Copy this setup" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0].targets[0]).toEqual({
      derive: {
        sourceEnvironmentId: "chat-other",
        expectedRevision: 5,
        overrides: {
          hostId: "chat",
          modelId: "new-model",
          serverAttachmentId: "servers",
        },
      },
    });
  });
});
