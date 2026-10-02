import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import {
  preflightTargets,
  readEnvironmentResolutions,
  runPreflight,
  RunPreflightNotices,
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
    ).toEqual({ serverRefs: ["billing", "srv-2"], refusals: [] });
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

  it("leaves a failure that is not a launch refusal to the run route", () => {
    expect(
      readEnvironmentResolutions({
        "env-a": new Error("Not a member of this project"),
        "env-b": new ConvexError({
          code: "RATE_LIMITED",
          message: "Slow down",
        }),
      }),
    ).toEqual({ serverRefs: [], refusals: [] });
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
      screen.getByText(/Anthropic isn't enabled for this project/),
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
