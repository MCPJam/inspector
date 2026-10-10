import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import {
  CHOOSE_ORG_JUDGE_MODEL,
  connectOutcome,
  hasBlockingPreflight,
  preflightJudgeOf,
  preflightTargets,
  readEnvironmentResolutions,
  runPreflight,
  RunPreflightNotices,
  scopePreflightToHosts,
} from "../suite-run-preflight";
import { SuiteRunReviewContent } from "../suite-run-review";
import type { EvalCase, EvalSuite } from "../../evals/types";

const connected = { connectionStatus: "connected" };
const anthropicOff = {
  providers: [
    { providerKey: "anthropic", enabled: false },
    { providerKey: "openai", enabled: true },
  ],
};

describe("runPreflight", () => {
  it("tells a server the browser knows but has not connected from one the project no longer has", () => {
    expect(
      runPreflight({
        serverRefs: ["billing", "crm", "local", "gone"],
        servers: {
          billing: connected,
          crm: { connectionStatus: "failed" },
          // Configured in this inspector, outside the project's list.
          local: { connectionStatus: "disconnected" },
        },
        projectServers: [
          { _id: "srv-1", name: "billing" },
          { _id: "srv-2", name: "crm" },
        ],
        models: [],
      }),
    ).toMatchObject({ disconnected: ["crm", "local"], removed: ["gone"] });
  });

  // An environment's resolution also lists its pinned plugins' servers, which
  // neither the browser nor the project's server list knows.
  it("leaves a server nobody here knows to the run when told to", () => {
    expect(
      runPreflight({
        serverRefs: ["billing", "plugin-tools"],
        servers: { billing: { connectionStatus: "disconnected" } },
        projectServers: [{ _id: "srv-1", name: "billing" }],
        models: [],
        knownOnly: true,
      }),
    ).toMatchObject({ disconnected: ["billing"], removed: [] });
  });

  it("calls nothing removed while the project's servers are unknown", () => {
    expect(
      runPreflight({ serverRefs: ["gone"], servers: {}, models: [] }),
    ).toMatchObject({ disconnected: ["gone"], removed: [] });
  });

  it("matches a project server by id as well as by name", () => {
    expect(
      runPreflight({
        serverRefs: ["srv-1", "crm"],
        servers: {},
        projectServers: [
          { _id: "srv-1", name: "billing" },
          { _id: "srv-2", name: "crm" },
        ],
        models: [],
      }),
    ).toMatchObject({ disconnected: ["srv-1", "crm"], removed: [] });
  });

  it("names each provider the org has not enabled once", () => {
    expect(
      runPreflight({
        serverRefs: [],
        servers: {},
        models: [
          { model: "claude-sonnet-4-5", provider: "anthropic" },
          { model: "claude-opus-4-1", provider: "anthropic" },
          { model: "gpt-5", provider: "openai" },
          { model: "mistral-large", provider: "mistral" },
        ],
        orgConfig: anthropicOff,
      }).disabledProviders,
    ).toEqual(["anthropic", "mistral"]);
  });

  it("does not judge providers before the org config loads", () => {
    expect(
      runPreflight({
        serverRefs: [],
        servers: {},
        models: [{ model: "claude-sonnet-4-5", provider: "anthropic" }],
      }).disabledProviders,
    ).toEqual([]);
  });

  it("leaves out models the run does not need a provider for", () => {
    expect(
      runPreflight({
        serverRefs: [],
        servers: {},
        models: [
          // Already offered in the picker, so something serves it.
          { model: "claude-haiku-4-5", provider: "anthropic" },
          // MCPJam serves it; no org provider involved.
          { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
          { model: "widget-probe", provider: "none" },
          { model: "cursor/auto", provider: "cursor" },
        ],
        availableModelIds: ["claude-haiku-4-5"],
        orgConfig: anthropicOff,
      }).disabledProviders,
    ).toEqual([]);
  });
});

describe("preflightTargets", () => {
  const cases = [
    { _id: "one", models: [{ model: "gpt-5", provider: "openai" }] },
  ] as unknown as EvalCase[];
  const targets = (suite: Partial<EvalSuite>) =>
    preflightTargets({
      suite: { _id: "suite", name: "S", ...suite } as EvalSuite,
      cases,
      environments: [
        {
          environmentId: "env-pinned",
          hostId: "claude",
          modelId: "openai/gpt-5",
        },
        { environmentId: "env-inherits", hostId: "claude" },
      ],
      hosts: [{ hostId: "claude", modelId: "anthropic/claude-sonnet-4-5" }],
      environmentServerRefs: ["billing"],
    });

  it("checks a legacy suite's own servers and its cases' models", () => {
    expect(targets({ environment: { servers: ["crm"] } } as never)).toEqual({
      serverRefs: ["crm"],
      models: [{ model: "gpt-5", provider: "openai" }],
    });
  });

  it("checks an environment's model, else its client's, and its resolved servers", () => {
    expect(
      targets({
        environment: { servers: ["legacy"] },
        environmentIds: ["env-pinned", "env-inherits"],
      } as never),
    ).toEqual({
      serverRefs: ["billing"],
      models: [
        { model: "openai/gpt-5", provider: "openai" },
        { model: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
      ],
    });
  });

  it("checks the cells the run will launch when they are known", () => {
    expect(
      preflightTargets({
        suite: { _id: "s", name: "S", environmentIds: ["env-pinned"] } as never,
        cases,
        environments: [],
        hosts: [{ hostId: "claude", modelId: "anthropic/claude-sonnet-4-5" }],
        environmentServerRefs: ["billing"],
        targets: [
          { hostId: "claude", modelId: "openai/gpt-5" },
          { hostId: "claude" },
        ],
      }).models,
    ).toEqual([
      { model: "openai/gpt-5", provider: "openai" },
      { model: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
    ]);
  });

  it("checks nothing for an SDK suite, which runs in the environment picked for it", () => {
    expect(
      targets({
        source: "sdk",
        environment: { servers: ["ci-only"] },
      } as never),
    ).toEqual({ serverRefs: [], models: [] });
  });
});

describe("readEnvironmentResolutions", () => {
  const deletedServer = new ConvexError({
    code: "ENV_SERVERS_UNRESOLVED",
    message:
      'Environment "Claude" has a deleted server "crm" in its server group. Choose the environment\'s servers again before running.',
  });

  it("collects each environment's servers by name, else by id", () => {
    expect(
      readEnvironmentResolutions({
        "env-a": { servers: [{ serverId: "srv-1", name: "billing" }] },
        "env-b": { servers: [{ serverId: "srv-2" }] },
        "env-c": undefined,
      }),
    ).toEqual({
      serverRefs: ["billing", "srv-2"],
      refusals: [],
      refusalByEnvironment: {},
    });
  });

  it("remembers which environment each refusal came from", () => {
    expect(
      readEnvironmentResolutions({
        "env-a": deletedServer,
        "env-b": { servers: [] },
      }).refusalByEnvironment,
    ).toEqual({ "env-a": deletedServer.data.message });
  });

  it("reports a launch refusal once, in the backend's words", () => {
    expect(
      readEnvironmentResolutions({
        "env-a": deletedServer,
        "env-b": deletedServer,
      }).refusals,
    ).toEqual([
      'Environment "Claude" has a deleted server "crm" in its server group. Choose the environment\'s servers again before running.',
    ]);
  });

  // The run route picks a local or hosted venue server-side; the browser
  // resolves as hosted, so a venue-only refusal may not apply to the launch.
  it("leaves a refusal that depends on where the run executes to the run route", () => {
    expect(
      readEnvironmentResolutions({
        "env-a": new ConvexError({
          code: "ENV_LOCAL_SERVERS_REQUIRED",
          message: "This environment requires a local runner.",
        }),
        "env-b": new ConvexError({
          code: "ENV_PLUGIN_COMPONENT_UNSUPPORTED",
          message: "Can't be used in a hosted run.",
        }),
      }).refusals,
    ).toEqual([]);
  });

  // A new cell brings its own client and model; it copies only the setup.
  it("ignores a template's client and model refusals, not its setup's", () => {
    const refusal = (code: string) =>
      new ConvexError({ code, message: `${code} message` });
    expect(
      readEnvironmentResolutions(
        {
          template: refusal("ENV_MODEL_REQUIRED"),
          "template-host": refusal("ENV_HOST_MISSING"),
          "template-servers": refusal("ENV_SERVERS_UNRESOLVED"),
          launched: refusal("ENV_MODEL_REQUIRED"),
        },
        new Set(["template", "template-host", "template-servers"]),
      ).refusals,
    ).toEqual(["ENV_SERVERS_UNRESOLVED message", "ENV_MODEL_REQUIRED message"]);
  });

  it("leaves a failure that is not a launch refusal to the run route", () => {
    expect(
      readEnvironmentResolutions({
        "env-a": new Error("Not a member of this project"),
        "env-b": new ConvexError({
          code: "RATE_LIMITED",
          message: "Slow down",
        }),
      }),
    ).toEqual({ serverRefs: [], refusals: [], refusalByEnvironment: {} });
  });
});

describe("scopePreflightToHosts", () => {
  const suite = {
    _id: "s",
    name: "S",
    environment: { servers: [] },
    hostAttachments: [
      { namedHostId: "a", resolvedServerNames: ["ok"] },
      { namedHostId: "b", resolvedServerNames: ["gone", "flaky"] },
    ],
  } as unknown as EvalSuite;
  const preflight = {
    disconnected: ["flaky"],
    removed: ["gone"],
    refused: [],
    disabledProviders: [],
    serverName: (ref: string) => ref,
  };

  it("drops server problems that only a deselected client has", () => {
    expect(scopePreflightToHosts(preflight, suite, ["a"])).toMatchObject({
      disconnected: [],
      removed: [],
    });
    expect(scopePreflightToHosts(preflight, suite, ["a", "b"])).toMatchObject({
      disconnected: ["flaky"],
      removed: ["gone"],
    });
  });
});

describe("connectOutcome", () => {
  const result = (over: Record<string, string[]>) => ({
    readyServerNames: [],
    missingServerNames: [],
    failedServerNames: [],
    reauthServerNames: [],
    ...over,
  });

  it("says nothing once the server is ready", () => {
    expect(connectOutcome("crm", result({ readyServerNames: ["crm"] }))).toBe(
      null,
    );
  });

  it("names a server that needs authorizing", () => {
    expect(connectOutcome("crm", result({ reauthServerNames: ["crm"] }))).toBe(
      "crm needs authorizing before it can connect.",
    );
  });

  it("names a server that didn't connect", () => {
    expect(connectOutcome("crm", result({ failedServerNames: ["crm"] }))).toBe(
      "crm didn't connect.",
    );
  });
});

describe("RunPreflightNotices", () => {
  it("connects a disconnected server from the sheet", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    render(
      <RunPreflightNotices
        preflight={{
          disconnected: ["crm"],
          removed: [],
          refused: [],
          disabledProviders: [],
          serverName: (ref) => ref,
          connect,
        }}
      />,
    );
    expect(screen.getByText(/crm isn't connected/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect crm" }));
    expect(connect).toHaveBeenCalledWith("crm");
  });

  it("says why a connect failed, with a way to fix it", async () => {
    render(
      <RunPreflightNotices
        preflight={{
          disconnected: ["crm"],
          removed: [],
          refused: [],
          disabledProviders: [],
          serverName: (ref) => ref,
          connect: vi.fn().mockResolvedValue("crm didn't connect."),
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect crm" }));
    expect(screen.getByRole("alert")).toHaveTextContent("crm didn't connect.");
    expect(
      screen.getByRole("button", { name: "Open Servers" }),
    ).toBeInTheDocument();
  });

  it("drops a connect failure once the server connects some other way", async () => {
    const preflight = {
      disconnected: ["crm"],
      removed: [],
      refused: [],
      disabledProviders: ["anthropic"],
      serverName: (ref: string) => ref,
      connect: vi.fn().mockResolvedValue("crm didn't connect."),
    };
    const { rerender } = render(<RunPreflightNotices preflight={preflight} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect crm" }));
    expect(screen.getByRole("alert")).toHaveTextContent("crm didn't connect.");
    // Connected from the Servers page; the provider notice keeps the box up.
    rerender(
      <RunPreflightNotices preflight={{ ...preflight, disconnected: [] }} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("links a disabled provider to the org's model settings", async () => {
    const manageModels = vi.fn();
    render(
      <RunPreflightNotices
        preflight={{
          disconnected: [],
          removed: [],
          refused: [],
          disabledProviders: ["anthropic"],
          serverName: (ref) => ref,
          manageModels,
        }}
      />,
    );
    expect(
      screen.getByText(/Anthropic isn't enabled in your organization/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage models" }),
    );
    expect(manageModels).toHaveBeenCalled();
  });
});

describe("Setup Run with a preflight", () => {
  const suite = {
    _id: "suite",
    name: "Checkout",
    environment: { servers: ["gone"] },
  } as unknown as EvalSuite;
  const cases = [{ _id: "one", runs: 1, models: [] }] as unknown as EvalCase[];

  it("sends a launch refusal to the suite's settings, not to Servers", async () => {
    const editSettings = vi.fn();
    render(
      <RunPreflightNotices
        preflight={{
          disconnected: [],
          removed: [],
          refused: ['Environment "Claude" has a deleted server "crm".'],
          disabledProviders: [],
          serverName: (ref) => ref,
        }}
        onEditSettings={editSettings}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Open Servers" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open suite settings" }),
    );
    expect(editSettings).toHaveBeenCalled();
  });

  it("starts once the client whose server is gone is deselected", async () => {
    const legacy = {
      _id: "suite",
      name: "Checkout",
      environment: { servers: [] },
      hostAttachments: [
        { namedHostId: "a", hostName: "A", resolvedServerNames: ["ok"] },
        { namedHostId: "b", hostName: "B", resolvedServerNames: ["gone"] },
      ],
    } as unknown as EvalSuite;
    render(
      <SuiteRunReviewContent
        suite={legacy}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi.fn()}
        onClose={vi.fn()}
        preflight={{
          disconnected: [],
          removed: ["gone"],
          refused: [],
          disabledProviders: [],
          serverName: (ref) => ref,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /Start run/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /^B/ }));
    expect(screen.getByRole("button", { name: /Start run/ })).toBeEnabled();
    expect(screen.queryByText(/gone is no longer/)).not.toBeInTheDocument();
  });

  // An older deployment picks environments with checkboxes, not the matrix.
  it("starts once the environment the backend refuses is deselected", async () => {
    render(
      <SuiteRunReviewContent
        suite={
          {
            _id: "suite",
            name: "Checkout",
            environment: { servers: [] },
            environmentIds: ["env-a", "env-b"],
          } as unknown as EvalSuite
        }
        cases={cases}
        environments={[
          { environmentId: "env-a", hostId: "h1", modelId: "model-a" },
          { environmentId: "env-b", hostId: "h1", modelId: "model-b" },
        ]}
        hostNamesById={new Map([["h1", "Claude"]])}
        onStart={vi.fn()}
        onClose={vi.fn()}
        preflight={{
          disconnected: [],
          removed: [],
          refused: ["env-a refused"],
          refusalByEnvironment: { "env-a": "env-a refused" },
          disabledProviders: [],
          serverName: (ref) => ref,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /Start run/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /model-a/ }));
    expect(screen.getByRole("button", { name: /Start run/ })).toBeEnabled();
    expect(screen.queryByText("env-a refused")).not.toBeInTheDocument();
  });

  it("blocks Start on an environment the backend refuses to launch", () => {
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi.fn()}
        onClose={vi.fn()}
        preflight={{
          disconnected: [],
          removed: [],
          refused: ['Environment "Claude" has a deleted server "crm".'],
          disabledProviders: [],
          serverName: (ref) => ref,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /Start run/ })).toBeDisabled();
    expect(
      screen.getByText(/Environment "Claude" has a deleted server "crm"/),
    ).toBeInTheDocument();
  });

  it("holds Start while a server is connecting from the sheet", async () => {
    let finish!: (value: string | null) => void;
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi.fn()}
        onClose={vi.fn()}
        preflight={{
          disconnected: ["crm"],
          removed: [],
          refused: [],
          disabledProviders: [],
          serverName: (ref) => ref,
          connect: () => new Promise((resolve) => (finish = resolve)),
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect crm" }));
    expect(screen.getByRole("button", { name: /Start run/ })).toBeDisabled();
    await act(async () => finish(null));
    expect(screen.getByRole("button", { name: /Start run/ })).toBeEnabled();
  });

  it("shows the backend's reason, not the raw Convex error", async () => {
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi
          .fn()
          .mockRejectedValue(
            new ConvexError({ code: "X", message: "Pick a model first." }),
          )}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Start run/ }));
    expect(await screen.findByText("Pick a model first.")).toBeInTheDocument();
    expect(screen.queryByText(/CONVEX/)).not.toBeInTheDocument();
  });

  it("drops a failed start's error once the run is set up differently", async () => {
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi.fn().mockRejectedValue(new Error("Model unavailable"))}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Start run/ }));
    expect(await screen.findByText("Model unavailable")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "More iterations" }),
    );
    expect(screen.queryByText("Model unavailable")).not.toBeInTheDocument();
  });

  it("blocks Start on a server the project no longer has", () => {
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi.fn()}
        onClose={vi.fn()}
        preflight={{
          disconnected: [],
          removed: ["gone"],
          refused: [],
          disabledProviders: [],
          serverName: (ref) => ref,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /Start run/ })).toBeDisabled();
    expect(
      screen.getByText(/gone is no longer in this project/),
    ).toBeInTheDocument();
  });

  it("still starts with only a disconnected server, asking the launch to report failures inline", async () => {
    const start = vi.fn();
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={start}
        onClose={vi.fn()}
        preflight={{
          disconnected: ["crm"],
          removed: [],
          refused: [],
          disabledProviders: ["anthropic"],
          serverName: (ref) => ref,
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Start run/ }));
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ throwOnFailure: true }),
    );
  });
});

describe("runPreflight while the organization requires its own keys", () => {
  const policy = {
    providers: [
      {
        id: "conn_anthropic",
        providerKey: "anthropic",
        enabled: true,
        hasSecret: true,
      },
      {
        id: "conn_router",
        providerKey: "openrouter",
        enabled: true,
        hasSecret: true,
      },
    ],
    aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
  };

  it("blocks a hosted target, a personal-key target and a hosted judge", () => {
    const preflight = runPreflight({
      serverRefs: [],
      servers: {},
      models: [
        { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
        { model: "llama3.2:latest", provider: "ollama" },
        {
          model: "anthropic/claude-sonnet-4.5",
          provider: "anthropic",
          selection: {
            source: "org",
            connectionRef: { kind: "orgProvider", id: "conn_anthropic" },
          },
        },
        {
          model: "openai/gpt-4o",
          provider: "openrouter",
          selection: {
            source: "org",
            connectionRef: { kind: "orgProvider", id: "conn_router" },
          },
        },
      ],
      orgConfig: policy,
      judge: { kind: "explicit", modelId: "openai/gpt-5-mini" },
    });

    expect(preflight.disabledProviders).toEqual([]);
    expect(preflight.orgKeyProblems).toHaveLength(4);
    expect(preflight.orgKeyProblems!.join("\n")).toMatch(
      /anthropic\/claude-haiku-4\.5 is an MCPJam-provided model/,
    );
    expect(preflight.orgKeyProblems!.join("\n")).toMatch(
      /llama3\.2:latest runs on a personal or local key/,
    );
    expect(preflight.orgKeyProblems!.join("\n")).toMatch(
      /openai\/gpt-4o uses an organization provider connection that can't run it/,
    );
    expect(preflight.orgKeyProblems!.join("\n")).toMatch(
      /The judge is an MCPJam-provided model/,
    );
    expect(
      preflight.orgKeyProblems!.every((problem) =>
        problem.endsWith("Choose a model from an organization provider."),
      ),
    ).toBe(true);
    expect(hasBlockingPreflight(preflight)).toBe(true);
  });

  it("lets an eligible org model and an org judge through", () => {
    const preflight = runPreflight({
      serverRefs: [],
      servers: {},
      models: [{ model: "claude-sonnet-4-5", provider: "anthropic" }],
      orgConfig: policy,
      judge: {
        kind: "explicit",
        modelId: "anthropic/claude-sonnet-4.5",
        selection: {
          source: "org",
          connectionRef: { kind: "orgProvider", id: "conn_anthropic" },
        },
      },
    });
    expect(preflight.orgKeyProblems).toBeUndefined();
    expect(hasBlockingPreflight(preflight)).toBe(false);
  });

  it("blocks a required judge nobody chose: there is no default judge on the organization's keys", () => {
    const preflight = runPreflight({
      serverRefs: [],
      servers: {},
      models: [{ model: "claude-sonnet-4-5", provider: "anthropic" }],
      orgConfig: policy,
      judge: { kind: "default" },
    });
    expect(preflight.orgKeyProblems).toEqual([CHOOSE_ORG_JUDGE_MODEL]);
    expect(CHOOSE_ORG_JUDGE_MODEL).toBe(
      "Choose a judge model from an organization provider.",
    );
    expect(hasBlockingPreflight(preflight)).toBe(true);
  });

  it("leaves the default judge alone with the policy off", () => {
    const preflight = runPreflight({
      serverRefs: [],
      servers: {},
      models: [],
      orgConfig: { ...policy, aiKeyPolicy: { requireOrgKeys: false } },
      judge: { kind: "default" },
    });
    expect(preflight.orgKeyProblems).toBeUndefined();
    expect(hasBlockingPreflight(preflight)).toBe(false);
  });

  it("reads the suite's judge only when grading is required", () => {
    expect(preflightJudgeOf({ judgeConfig: undefined })).toBeUndefined();
    expect(
      preflightJudgeOf({
        judgeConfig: { goalCompletion: { enabled: true, autoRun: true } },
      }),
    ).toEqual({ kind: "default" });
    expect(
      preflightJudgeOf({
        judgeConfig: {
          goalCompletion: { autoRun: true, judgeModel: "openai/gpt-5-mini" },
        },
      }),
    ).toEqual({
      kind: "explicit",
      modelId: "openai/gpt-5-mini",
      selection: null,
    });
    expect(
      preflightJudgeOf({
        judgeConfig: {
          goalCompletion: {
            role: "gating",
            enabled: false,
            judgeModel: "openai/gpt-5-mini",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("renders the problems as blocking notices with the admin action", async () => {
    const manageModels = vi.fn();
    render(
      <RunPreflightNotices
        preflight={{
          disconnected: [],
          removed: [],
          refused: [],
          disabledProviders: [],
          orgKeyProblems: ["The judge is an MCPJam-provided model."],
          serverName: (ref) => ref,
          manageModels,
        }}
      />,
    );
    expect(
      screen.getByText("The judge is an MCPJam-provided model."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage AI providers" }),
    );
    expect(manageModels).toHaveBeenCalled();
  });
});

describe("Setup Run — the backend's AI key policy refusal", () => {
  const suite = {
    _id: "suite",
    name: "Checkout",
    environment: { servers: [] },
  } as unknown as EvalSuite;
  const cases = [{ _id: "one", runs: 1, models: [] }] as unknown as EvalCase[];

  it("lists every problem the launch was refused for", async () => {
    render(
      <SuiteRunReviewContent
        suite={suite}
        cases={cases}
        hostNamesById={new Map()}
        onStart={vi.fn().mockRejectedValue(
          new ConvexError({
            code: "org_keys_required",
            message: "This organization requires its own provider keys…",
            problems: [
              {
                dependency: "target",
                label: "anthropic/claude-haiku-4.5",
                code: "org_keys_required",
                reason:
                  "anthropic/claude-haiku-4.5 is not a model from an organization provider. Choose a model from an organization provider.",
              },
              {
                dependency: "judge",
                label: "The judge",
                code: "org_keys_required",
                reason: "Choose a judge model from an organization provider.",
              },
            ],
          }),
        )}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Start run/ }));
    const list = await screen.findByTestId("ai-launch-problems");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list).toHaveTextContent(
      "Model: anthropic/claude-haiku-4.5 is not a model from an organization provider.",
    );
    expect(list).toHaveTextContent(
      "Judge: Choose a judge model from an organization provider.",
    );
  });
});
