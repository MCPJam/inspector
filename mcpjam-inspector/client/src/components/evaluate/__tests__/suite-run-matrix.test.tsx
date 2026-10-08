import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { SuiteRunReview } from "../suite-run-review";
import {
  inEnvironmentBatches,
  plannedPreflight,
  planRunMatrix,
  seedRunMatrix,
  seedSuiteRunGroup,
  suiteCaseModels,
  suiteRunClients,
} from "../suite-run-matrix";
import type { EvalSuite, EvalCase } from "../../evals/types";
const {
  ensure,
  query,
  mutation,
  capabilities,
  projectEnvironments,
  groups,
  projectDefault,
  availableModels,
  useQueries,
  projectServers,
  userReady,
  composeCapable,
} = vi.hoisted(() => ({
  useQueries: vi.fn((_queries: Record<string, unknown>) => ({})),
  projectServers: { value: undefined as unknown[] | undefined },
  userReady: { value: true },
  composeCapable: { value: true },
  ensure: vi.fn(),
  query: vi.fn(async () => ({ ephemeralEnvironmentLaunch: true })),
  mutation: vi.fn(),
  capabilities: {
    value: null as {
      environmentDerivation?: boolean;
      ephemeralEnvironmentLaunch?: boolean;
    } | null,
  },
  projectEnvironments: { value: [] as unknown[] | undefined },
  groups: { value: [] as unknown[] },
  projectDefault: { value: null as { id?: string } | null | undefined },
  availableModels: { value: [] as Array<{ id: string }> },
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({ query, mutation }),
  useConvexAuth: () => ({ isAuthenticated: true }),
  // `hostConfigsV2:getProjectDefault`; the preflight's other reads stay empty.
  useQuery: (name: string, args: unknown) =>
    args !== "skip" && name === "hostConfigsV2:getProjectDefault"
      ? projectDefault.value
      : undefined,
  // The run preflight's environment resolutions.
  useQueries: (queries: Record<string, unknown>) => useQueries(queries),
}));
// A signed-in, ready user: the preflight only resolves environments then.
vi.mock("@/contexts/db-user-ready-context", async (original) => ({
  ...(await original<typeof import("@/contexts/db-user-ready-context")>()),
  useDbUserReady: () => userReady.value,
}));
// The mount-time capabilities probe; `query` then only sees launch probes.
vi.mock("@/hooks/use-environment-capabilities", () => ({
  useEnvironmentCapabilities: () => capabilities.value,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      {
        hostId: "claude",
        name: "Claude",
        modelId: "sonnet",
        hostConfigId: "cfg-claude",
      },
      {
        hostId: "mcpjam",
        name: "MCPJam",
        modelId: "",
        hostConfigId: "cfg-mcpjam",
      },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: availableModels.value }),
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useEnsureAdhocEnvironments: () => ensure,
  useProjectEnvironments: () => projectEnvironments.value,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: ({
    projectId,
  }: {
    projectId: string | null;
  }) => ({
    serverAttachments: projectId ? groups.value : [],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: (projectId: string | null | undefined) =>
    Boolean(projectId),
  // The preflight reads the project's servers; undefined while loading.
  useProjectServers: () => ({ servers: projectServers.value }),
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({
    capable: composeCapable.value,
    pending: false,
  }),
}));
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
    <button
      data-testid="server-picker"
      disabled={disabled}
      onClick={() => onChange("picked-group")}
    >
      {value ?? emptyTriggerLabel}
    </button>
  ),
}));
vi.mock("../eval-target-matrix", () => ({
  EvalTargetMatrix: ({
    onModelSelectionChange,
    modelSelectionsByHost,
    disabled,
  }: {
    onModelSelectionChange: (id: string, value: unknown) => void;
    modelSelectionsByHost: unknown;
    disabled: boolean;
  }) => (
    <>
      <output data-testid="matrix">
        {JSON.stringify(modelSelectionsByHost)}
      </output>
      <button
        disabled={disabled}
        onClick={() =>
          onModelSelectionChange("claude", {
            includeClientDefaults: false,
            explicitTargets: [{ modelId: "opus" }],
          })
        }
      >
        Change model
      </button>
    </>
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
    claude: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "sonnet" }],
    },
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
      claude: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "opus" }],
      },
    })[0].stack,
  ).toEqual({
    hostId: "claude",
    modelId: "opus",
    serverAttachmentId: "servers",
  });
});

describe("reasoning effort in the run matrix", () => {
  const selectionWith = (effort?: string) => ({
    modelId: "sonnet",
    source: "hosted" as const,
    fallback: { provider: "none" as const, model: "none" as const },
    ...(effort ? { settings: { reasoningEffort: effort } } : {}),
  });
  const withEffort = [
    {
      ...environments[0],
      modelSelection: selectionWith("high"),
    },
  ] as typeof environments;

  it("seeds the matrix from the environment's own selection", () => {
    expect(
      seedRunMatrix(suite, withEffort as never).claude.explicitTargets[0]
        ?.selection?.settings?.reasoningEffort,
    ).toBe("high");
  });

  it("reuses the environment while its effort is unchanged", () => {
    const selection = seedRunMatrix(suite, withEffort as never);
    const [cell] = planRunMatrix(suite, withEffort as never, selection, {
      modelSelections: true,
    });
    expect(cell.environmentId).toBe("env");
  });

  it("seeds two efforts of one model as two cells, each reusing its own environment", () => {
    const siblings = [
      {
        ...environments[0],
        environmentId: "env-low",
        modelSelection: selectionWith("low"),
      },
      {
        ...environments[0],
        environmentId: "env-high",
        modelSelection: selectionWith("high"),
      },
    ] as typeof environments;
    const siblingSuite = { ...suite, environmentIds: ["env-low", "env-high"] };
    const selection = seedRunMatrix(siblingSuite, siblings as never);
    expect(
      selection.claude.explicitTargets.map(
        (target) => target.selection?.settings?.reasoningEffort,
      ),
    ).toEqual(["low", "high"]);
    const cells = planRunMatrix(siblingSuite, siblings as never, selection, {
      modelSelections: true,
    });
    expect(cells.map((cell) => cell.environmentId)).toEqual([
      "env-low",
      "env-high",
    ]);
  });

  it("an added effort of a seeded model plans one new cell beside the reused one", () => {
    const selection = seedRunMatrix(suite, withEffort as never);
    const cells = planRunMatrix(
      suite,
      withEffort as never,
      {
        claude: {
          ...selection.claude,
          explicitTargets: [
            ...selection.claude.explicitTargets,
            { modelId: "sonnet", selection: selectionWith("low") as never },
          ],
        },
      },
      { modelSelections: true },
    );
    expect(cells).toHaveLength(2);
    expect(cells[0].environmentId).toBe("env");
    expect(cells[1].environmentId).toBeUndefined();
    expect(cells[1].stack).toMatchObject({
      modelSelection: { settings: { reasoningEffort: "low" } },
    });
  });

  it("default-only rows seed and reuse exactly as before", () => {
    const plain = [
      { ...environments[0], environmentId: "a" },
      { ...environments[0], environmentId: "b", modelId: "opus" },
    ];
    const plainSuite = { ...suite, environmentIds: ["a", "b"] };
    const selection = seedRunMatrix(plainSuite, plain);
    expect(selection).toEqual({
      claude: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "sonnet" }, { modelId: "opus" }],
      },
    });
    expect(
      planRunMatrix(plainSuite, plain, selection, {
        modelSelections: true,
      }).map((cell) => cell.environmentId),
    ).toEqual(["a", "b"]);
  });

  it("keeps both environments that differ only by effort (High and default)", () => {
    const siblings = [
      {
        ...environments[0],
        environmentId: "env-high",
        modelSelection: selectionWith("high"),
      },
      { ...environments[0], environmentId: "env-default" },
    ] as typeof environments;
    const siblingSuite = {
      ...suite,
      environmentIds: ["env-high", "env-default"],
    };
    const selection = seedRunMatrix(siblingSuite, siblings as never);
    const cells = planRunMatrix(siblingSuite, siblings as never, selection, {
      modelSelections: true,
    });
    expect(cells.map((cell) => cell.environmentId)).toEqual([
      "env-high",
      "env-default",
    ]);
  });

  it("plans a new cell, carrying the selection, when the effort changes", () => {
    const [cell] = planRunMatrix(
      suite,
      withEffort as never,
      {
        claude: {
          includeClientDefaults: false,
          explicitTargets: [
            { modelId: "sonnet", selection: selectionWith("low") as never },
          ],
        },
      },
      { modelSelections: true },
    );
    expect(cell.environmentId).toBeUndefined();
    expect(cell.stack).toMatchObject({
      hostId: "claude",
      modelId: "sonnet",
      modelSelection: { settings: { reasoningEffort: "low" } },
    });
  });

  it("sends the selection on a derived cell's overrides", () => {
    const [cell] = planRunMatrix(
      suite,
      withEffort as never,
      {
        claude: {
          includeClientDefaults: false,
          explicitTargets: [
            { modelId: "sonnet", selection: selectionWith() as never },
          ],
        },
      },
      { modelSelections: true, lossless: true },
    );
    expect(cell.derive?.overrides).toMatchObject({
      hostId: "claude",
      modelId: "sonnet",
      modelSelection: { modelId: "sonnet" },
    });
    expect(cell.derive?.overrides.modelSelection?.settings).toBeUndefined();
  });

  it("ignores efforts where the deployment stores no selections", () => {
    const [cell] = planRunMatrix(
      suite,
      withEffort as never,
      {
        claude: {
          includeClientDefaults: false,
          explicitTargets: [
            { modelId: "sonnet", selection: selectionWith("low") as never },
          ],
        },
      },
      {},
    );
    expect(cell.environmentId).toBe("env");
  });
});

it("never derives a new cell's servers from the suite's legacy group", () => {
  // The environment has no group; the suite's legacy field does. An
  // environment suite does not read that field, so copying it would be a
  // guess — the cell must be refused instead.
  const [cell] = planRunMatrix(
    { ...suite, serverAttachmentId: "legacy-group" },
    [{ ...environments[0], serverAttachmentId: undefined }],
    {
      claude: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "opus" }],
      },
    },
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
    {
      claude: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "opus" }],
      },
    },
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
    {
      claude: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "opus" }],
      },
    },
  );
  expect(cell.blocked).toMatch(/grants project secrets/);
});
it("preflights the cells a run launches, and the setup a new cell copies", () => {
  const plan = planRunMatrix(suite, environments, {
    claude: {
      includeClientDefaults: true,
      explicitTargets: [{ modelId: "sonnet" }],
    },
  });
  expect(plannedPreflight(plan)).toEqual({
    environmentIds: ["env"],
    // "env" also launches as itself, so nothing about it is template-only.
    templateOnlyIds: [],
    targets: [{ hostId: "claude" }, { hostId: "claude", modelId: "sonnet" }],
  });
  // A new cell alone still brings the setup it copies.
  const newOnly = planRunMatrix(suite, environments, {
    claude: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "opus" }],
    },
  });
  expect(plannedPreflight(newOnly)).toMatchObject({
    environmentIds: ["env"],
    templateOnlyIds: ["env"],
  });
});

describe("with the backend's answer", () => {
  const renderReview = () =>
    render(
      <SuiteRunReview
        projectId="project"
        suite={suite}
        cases={cases}
        environments={environments}
        hostNamesById={new Map()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

  it("blocks Start on an environment the backend refuses", () => {
    useQueries.mockImplementation(() => ({
      env: new ConvexError({
        code: "ENV_SERVERS_UNRESOLVED",
        message:
          'Server "crm" in this environment\'s server group was deleted. Pick the servers again before running.',
      }),
    }));
    renderReview();
    expect(screen.getByText(/Server "crm" in this environment/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start run" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("asks nothing before the user is ready", () => {
    userReady.value = false;
    renderReview();
    expect(useQueries).toHaveBeenLastCalledWith({});
  });

  // An older deployment picks environments with checkboxes, not the matrix.
  it("lets an older deployment start once the refused environment is deselected", () => {
    composeCapable.value = false;
    useQueries.mockImplementation(() => ({
      env: new ConvexError({
        code: "ENV_SERVERS_UNRESOLVED",
        message: "env refused",
      }),
      "env-opus": { servers: [] },
    }));
    render(
      <SuiteRunReview
        projectId="project"
        suite={{ ...suite, environmentIds: ["env", "env-opus"] }}
        cases={cases}
        environments={[
          environments[0],
          { ...environments[0], environmentId: "env-opus", modelId: "opus" },
        ]}
        hostNamesById={new Map()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const start = () => screen.getByRole("button", { name: "Start run" });
    expect(start()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /sonnet/ }));
    expect(start()).toHaveProperty("disabled", false);
  });

  it("lets Start through while the resolution is still loading", () => {
    useQueries.mockImplementation(() => ({ env: undefined }));
    renderReview();
    expect(screen.getByRole("button", { name: "Start run" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  // The project's server list leaves plugin components out, so a pinned
  // plugin's server is neither connected nor listed, and is not "removed".
  it("does not call a pinned plugin's server removed", () => {
    projectServers.value = [];
    useQueries.mockImplementation(() => ({
      env: { servers: [{ serverId: "srv-plugin", name: "plugin-tools" }] },
    }));
    renderReview();
    expect(screen.queryByText(/plugin-tools/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start run" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

it("stops preflighting a saved pairing once it is deselected", () => {
  const twoModels = { ...suite, environmentIds: ["env", "env-opus"] };
  const both = [
    environments[0],
    { ...environments[0], environmentId: "env-opus", modelId: "opus" },
  ];
  useQueries.mockClear();
  render(
    <SuiteRunReview
      projectId="project"
      suite={twoModels}
      cases={cases}
      environments={both}
      hostNamesById={new Map()}
      onStart={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const asked = () => Object.keys(useQueries.mock.lastCall?.[0] ?? {});
  expect(asked()).toEqual(["env", "env-opus"]);
  // The matrix stub keeps only "opus" on this client.
  fireEvent.click(screen.getByRole("button", { name: "Change model" }));
  expect(asked()).toEqual(["env-opus"]);
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
      {
        iterationOverride: 5,
        ephemeralEnvironment: true,
        throwOnFailure: true,
      },
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
  useQueries.mockImplementation(() => ({}));
  useQueries.mockClear();
  projectServers.value = undefined;
  userReady.value = true;
  composeCapable.value = true;
  ensure.mockReset();
  query.mockReset();
  query.mockResolvedValue({ ephemeralEnvironmentLaunch: true });
  mutation.mockReset();
  capabilities.value = null;
  projectEnvironments.value = [];
  groups.value = [];
  projectDefault.value = null;
  availableModels.value = [];
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
      { iterationOverride: 5, throwOnFailure: true },
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

it("launches a suite without environments through its own configuration on a backend without one-run launches", async () => {
  // `capabilities` is null: no one-run cells, so nothing is composed here.
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

it("derives a one-run cell from a pinned setup on the backend instead of blocking it", () => {
  const pinned = [
    {
      ...environments[0],
      revision: 6,
      pluginVersionIds: ["pin"],
      secretSelection: { mode: "explicit", secretIds: ["secret"] },
    },
  ];
  const opus = {
    claude: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "opus" }],
    },
  };
  expect(planRunMatrix(suite, pinned, opus)[0].blocked).toMatch(
    /pins plugin versions/,
  );
  const [cell] = planRunMatrix(suite, pinned, opus, { lossless: true });
  expect(cell.blocked).toBeUndefined();
  expect(cell.derive).toEqual({
    sourceEnvironmentId: "env",
    expectedRevision: 6,
    overrides: { hostId: "claude", modelId: "opus" },
  });
});

it("launches a derived cell without modifying the suite", async () => {
  capabilities.value = { environmentDerivation: true };
  mutation.mockResolvedValue([{ environment: { environmentId: "derived" } }]);
  const onStart = vi.fn();
  render(
    <SuiteRunReview
      projectId="project"
      suite={suite}
      cases={cases}
      environments={[{ ...environments[0], revision: 2 }]}
      hostNamesById={new Map()}
      onStart={onStart}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change model" }));
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ environmentIds: ["derived"] }),
      {
        iterationOverride: 5,
        ephemeralEnvironment: true,
        throwOnFailure: true,
      },
    ),
  );
  expect(mutation).toHaveBeenCalledWith(
    "projectEnvironments:deriveEnvironments",
    {
      projectId: "project",
      derivations: [
        {
          sourceEnvironmentId: "env",
          expectedRevision: 2,
          overrides: { hostId: "claude", modelId: "opus" },
        },
      ],
    },
  );
  expect(ensure).not.toHaveBeenCalled();
  expect(suite.environmentIds).toEqual(["env"]);
});

describe("a suite without environments", () => {
  const legacy = {
    ...suite,
    projectId: "project",
    environmentIds: undefined,
    serverAttachmentId: "excalidraw",
    selectedSkillIds: ["skill-1"],
    environment: {
      servers: ["Excalidraw (App)"],
      computerEnvironmentId: "image-1",
    },
    hostAttachments: [],
  } as unknown as EvalSuite;
  const legacyCases = [
    {
      _id: "draw",
      runs: 1,
      models: [{ model: "haiku", provider: "anthropic" }],
    },
    {
      _id: "share",
      runs: 1,
      models: [
        { model: "haiku", provider: "anthropic" },
        // Not offered in this project: never pre-picked.
        { model: "retired", provider: "anthropic" },
      ],
    },
  ] as unknown as EvalCase[];
  const renderLegacy = (
    overrides: Partial<EvalSuite> = {},
    onStart = vi.fn(),
  ) =>
    render(
      <SuiteRunReview
        projectId="project"
        suite={{ ...legacy, ...overrides }}
        cases={legacyCases}
        environments={[]}
        hostNamesById={new Map()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );
  const matrixState = () =>
    JSON.parse(screen.getByTestId("matrix").textContent ?? "{}");

  beforeEach(() => {
    capabilities.value = { ephemeralEnvironmentLaunch: true };
    groups.value = [
      {
        _id: "excalidraw",
        name: "Excalidraw",
        serverIds: ["server-1"],
        resolvedServerNames: ["Excalidraw (App)"],
      },
    ];
    projectDefault.value = { id: "cfg-mcpjam" };
    availableModels.value = [{ id: "haiku" }];
  });

  // Its cells run on the server group picked here, not on the servers the
  // suite saved, so those are what the preflight checks.
  it("preflights the picked group's servers, not the suite's own", () => {
    projectServers.value = [{ _id: "server-1", name: "Excalidraw (App)" }];
    renderLegacy({ environment: { servers: ["gone-from-project"] } } as never);
    expect(screen.getByText(/Excalidraw \(App\) isn't connected/)).toBeTruthy();
    expect(screen.queryByText(/gone-from-project/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start run" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("pre-fills its servers, the project's default client and the cases' models, then runs one-run cells", async () => {
    ensure.mockResolvedValue([{ environment: { environmentId: "one-run" } }]);
    const onStart = vi.fn();
    renderLegacy({}, onStart);
    expect(screen.queryByText("Suite configuration")).toBeNull();
    expect(screen.getByTestId("server-picker")).toHaveTextContent("excalidraw");
    expect(matrixState()).toEqual({
      mcpjam: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "haiku" }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ environmentIds: ["one-run"] }),
        {
          iterationOverride: 5,
          ephemeralEnvironment: true,
          throwOnFailure: true,
        },
      ),
    );
    // The suite's own skills and image ride along; the suite is not changed.
    expect(ensure).toHaveBeenCalledWith({
      projectId: "project",
      stacks: [
        {
          hostId: "mcpjam",
          modelId: "haiku",
          serverAttachmentId: "excalidraw",
          skillSelection: { mode: "explicit", skillIds: ["skill-1"] },
          computerEnvironmentId: "image-1",
        },
      ],
    });
    expect(legacy.environmentIds).toBeUndefined();
  });

  it("starts from the clients it attaches that still exist", () => {
    renderLegacy({
      hostAttachments: [
        {
          namedHostId: "claude",
          enabledOptionalServerIds: [],
          hostName: "Claude",
          resolvedServerNames: [],
        },
        {
          namedHostId: "deleted",
          enabledOptionalServerIds: [],
          hostName: "Gone",
          resolvedServerNames: [],
        },
      ],
    });
    expect(Object.keys(matrixState())).toEqual(["claude"]);
  });

  it("blocks Start until a server group is picked when its own is not in this project", () => {
    groups.value = [];
    renderLegacy();
    const start = screen.getByRole("button", { name: "Start run" });
    expect(screen.getByTestId("server-picker")).toHaveTextContent(
      "Pick a server group",
    );
    expect(
      screen.getByText("Pick a server group to run this suite."),
    ).toBeVisible();
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByTestId("server-picker"));
    expect(start).toBeEnabled();
  });

  it("keeps the suite's own launch for a suite outside this project", () => {
    renderLegacy({ projectId: "other-project" });
    expect(screen.queryByTestId("server-picker")).toBeNull();
    expect(screen.getByText("Suite configuration")).toBeVisible();
  });
});

describe("an SDK suite", () => {
  const sdkSuite = {
    ...suite,
    projectId: "project",
    source: "sdk",
    environmentIds: undefined,
    serverAttachmentId: undefined,
    hostAttachments: [],
    // The reporter's server names: never a source for the run's servers.
    environment: { servers: ["foreflight"] },
  } as unknown as EvalSuite;
  const renderSdk = (onStart = vi.fn()) =>
    render(
      <SuiteRunReview
        projectId="project"
        suite={sdkSuite}
        cases={cases}
        environments={[]}
        hostNamesById={new Map([["claude", "Claude"]])}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

  beforeEach(() => {
    capabilities.value = { ephemeralEnvironmentLaunch: true };
    groups.value = [
      {
        _id: "foreflight",
        name: "foreflight",
        serverIds: ["server-1"],
        resolvedServerNames: ["foreflight"],
      },
    ];
  });

  it("runs a new setup on the picked servers without attaching it", async () => {
    ensure.mockResolvedValue([{ environment: { environmentId: "one-run" } }]);
    const onStart = vi.fn();
    renderSdk(onStart);
    // No saved environment with servers: nothing to switch to.
    expect(
      screen.queryByRole("radio", { name: "Saved environment" }),
    ).toBeNull();
    expect(screen.getByTestId("server-picker")).toHaveTextContent(
      "Pick a server group",
    );
    const start = screen.getByRole("button", { name: "Start run" });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByTestId("server-picker"));
    fireEvent.click(start);
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ environmentIds: ["one-run"] }),
        {
          iterationOverride: 5,
          ephemeralEnvironment: true,
          throwOnFailure: true,
        },
      ),
    );
    expect(ensure).toHaveBeenCalledWith({
      projectId: "project",
      stacks: [{ hostId: "claude", serverAttachmentId: "picked-group" }],
    });
  });

  it("can run in a saved project environment instead", async () => {
    projectEnvironments.value = [
      {
        environmentId: "prod",
        name: "Prod",
        hostId: "claude",
        modelId: "anthropic/claude-sonnet-4-6",
        serverAttachmentId: "servers",
      },
      // No servers: not offered, it could only fail.
      { environmentId: "empty", name: "Empty", hostId: "claude" },
    ];
    const onStart = vi.fn();
    renderSdk(onStart);
    fireEvent.click(screen.getByRole("radio", { name: "Saved environment" }));
    expect(screen.queryByTestId("server-picker")).toBeNull();
    expect(screen.queryByRole("radio", { name: /Empty/ })).toBeNull();
    const start = screen.getByRole("button", { name: "Start run" });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Prod/ }));
    fireEvent.click(start);
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentIds: ["prod"],
          hostAttachments: [],
        }),
        {
          iterationOverride: 5,
          ephemeralEnvironment: true,
          throwOnFailure: true,
        },
      ),
    );
    expect(ensure).not.toHaveBeenCalled();
  });

  it("keeps the suite's own launch on a backend without ephemeral launches", () => {
    capabilities.value = { environmentDerivation: true };
    renderSdk();
    expect(screen.queryByTestId("server-picker")).toBeNull();
    expect(screen.queryByTestId("sdk-suite-run-environment")).toBeNull();
    expect(screen.getByText("Suite configuration")).toBeVisible();
  });
});

describe("seeding a suite without environments", () => {
  const selection = (effort: string) => ({
    modelId: "sonnet",
    source: "hosted" as const,
    fallback: { provider: "none" as const, model: "none" as const },
    settings: { reasoningEffort: effort },
  });
  const runnable = new Set(["sonnet", "haiku", "default-model"]);

  it("takes the cases' runnable models, skipping model-free cases and the SDK's n/a", () => {
    const models = suiteCaseModels(
      {},
      [
        {
          models: [
            {
              model: "sonnet",
              provider: "anthropic",
              selection: selection("high"),
            },
            { model: "n/a", provider: "external" },
            { model: "retired", provider: "anthropic" },
          ],
        },
        // A render check runs no model, whatever it lists.
        {
          models: [{ model: "haiku", provider: "anthropic" }],
          steps: [{ kind: "toolCall", toolName: "draw", arguments: {} }],
        },
      ] as never,
      runnable,
    );
    expect(models.includeClientDefaults).toBe(false);
    expect(models.explicitTargets).toEqual([
      { modelId: "sonnet", selection: selection("high") },
    ]);
  });

  it("keeps an old-format selection's model as a bare id", () => {
    expect(
      suiteCaseModels(
        {},
        [
          {
            models: [
              {
                model: "sonnet",
                provider: "anthropic",
                selection: { source: "legacy", modelId: "sonnet" },
              },
            ],
          },
        ] as never,
        runnable,
      ).explicitTargets,
    ).toEqual([{ modelId: "sonnet" }]);
  });

  it("adds the suite default for a prompt case with no model, else the client's own model", () => {
    const noModels = [{ models: [] }] as never;
    expect(
      suiteCaseModels(
        { defaultConfig: { modelId: "default-model" } } as never,
        noModels,
        runnable,
      ).explicitTargets,
    ).toEqual([{ modelId: "default-model" }]);
    expect(suiteCaseModels({}, noModels, runnable)).toEqual({
      includeClientDefaults: true,
      explicitTargets: [],
    });
  });

  it("starts from the backend's default client when the suite attaches none", () => {
    const hosts = [
      {
        hostId: "owned",
        hostConfigId: "cfg-default",
        ownerScope: { type: "journeys" as const },
      },
      { hostId: "first", hostConfigId: "cfg-first", ownerScope: null },
      { hostId: "default", hostConfigId: "cfg-default" },
    ];
    expect(suiteRunClients({}, hosts, "cfg-default")).toEqual(["default"]);
    expect(suiteRunClients({}, hosts, "cfg-unknown")).toEqual(["first"]);
    expect(suiteRunClients({}, [], "cfg-default")).toEqual([]);
  });

  it("offers the suite's own group only while it is in this project with a live server", () => {
    const group = { _id: "g", resolvedServerNames: ["billing"] };
    expect(seedSuiteRunGroup({ serverAttachmentId: "g" }, [group])).toBe("g");
    expect(
      seedSuiteRunGroup({ serverAttachmentId: "g" }, [
        { _id: "g", resolvedServerNames: ["[deleted server]"] },
      ]),
    ).toBeNull();
    expect(
      seedSuiteRunGroup({ serverAttachmentId: "other" }, [group]),
    ).toBeNull();
    expect(seedSuiteRunGroup({}, [group])).toBeNull();
  });

  it("plans a cell on the picked group, or blocks it without one", () => {
    const legacy = {
      ...suite,
      environmentIds: undefined,
      serverAttachmentId: "legacy-group",
      selectedSkillIds: ["skill-1"],
      environment: { servers: [], computerEnvironmentId: "image-1" },
    } as unknown as EvalSuite;
    const cells = {
      mcpjam: {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "haiku" }],
      },
    };
    expect(planRunMatrix(legacy, [], cells, { group: "picked" })).toEqual([
      {
        stack: {
          hostId: "mcpjam",
          modelId: "haiku",
          serverAttachmentId: "picked",
          skillSelection: { mode: "explicit", skillIds: ["skill-1"] },
          computerEnvironmentId: "image-1",
        },
      },
    ]);
    // Never the suite's own field unseen: the dialog pre-fills `group`.
    expect(planRunMatrix(legacy, [], cells)).toEqual([
      { stack: { hostId: "mcpjam", modelId: "haiku" }, missingGroup: true },
    ]);
  });
});

it("finds or creates environments ten at a time, in order", async () => {
  const run = vi.fn(async (batch: number[]) => batch.map((item) => item * 2));
  const items = Array.from({ length: 12 }, (_, index) => index);
  await expect(inEnvironmentBatches(items, run)).resolves.toEqual(
    items.map((item) => item * 2),
  );
  expect(run.mock.calls.map(([batch]) => batch.length)).toEqual([10, 2]);
  await expect(inEnvironmentBatches([], run)).resolves.toEqual([]);
  expect(run).toHaveBeenCalledTimes(2);
});
