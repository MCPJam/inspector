import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostDetail } from "@/hooks/useClients";
import type { ModelDefinition } from "@/shared/types";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import {
  resolvePlaygroundClientColumn,
  type PlaygroundClientResolution,
} from "@/lib/playground-client-columns";
import { resolveEnvironmentPaneColumn } from "@/lib/compare-environment-columns";
import type { ComparePaneEnvironment } from "@/hooks/use-compare-environment-panes";
import type { ComparePaneTargetOption } from "../compare-pane-target-select";
import { useComparePaneStore } from "@/stores/compare-pane-store";
import {
  useComparePaneControls,
  type ComparePaneSections,
} from "../use-compare-pane-controls";
import type { ComparePaneLane } from "../compare-pane-settings";

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light" | "dark" }) => unknown,
  ) => selector({ themeMode: "light" }),
}));

const catalog: ModelDefinition[] = [
  "openai/gpt-5.5",
  "openai/gpt-5-mini",
  "anthropic/claude-haiku-4.5",
].map((id) => ({
  id,
  name: id,
  provider: id.split("/")[0] as ModelDefinition["provider"],
  hosted: true,
}));

function client(hostId: string, harness: string, modelId: string): HostDetail {
  return {
    hostId,
    name: hostId,
    config: {
      schemaVersion: 2,
      hostStyle: "chatgpt",
      harness,
      modelId,
      systemPrompt: "",
      temperature: 0,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      clientCapabilities: {},
      hostContext: {},
      connectionDefaults: { headers: {}, requestTimeout: 30000 },
    } as HostDetail["config"],
  };
}

const codex = client("codex", "codex", "openai/gpt-5.5");
const cursor = client("cursor", "cursor", "cursor/auto");
const panes: RecoveryPane[] = [
  { paneId: "codex", target: { kind: "host", hostId: "codex" } },
  { paneId: "cursor", target: { kind: "host", hostId: "cursor" } },
];
const resolutions = [codex, cursor].map((host) =>
  resolvePlaygroundClientColumn({
    paneId: host.hostId,
    hostId: host.hostId,
    slot: { host, isLoading: false },
    hosts: [],
    models: catalog,
  }),
);
const serverIdByName = new Map([
  ["GitHub", "srv-github"],
  ["Docs", "srv-docs"],
]);

const clientTargets = [codex, cursor].map((host) => ({
  target: { kind: "host" as const, hostId: host.hostId },
  label: host.hostId,
}));

function Harness({
  paneId,
  lane = { environmentId: null, pending: false },
  overrides = {},
  sections,
  spies,
  lineup = panes,
  lineupResolutions = resolutions,
  environments = [],
  paneEnvironments = new Map(),
}: {
  paneId: string;
  lane?: ComparePaneLane;
  overrides?: Partial<Record<string, Partial<RecoveryPane>>>;
  sections?: ComparePaneSections;
  spies: {
    restorePanes: ReturnType<typeof vi.fn>;
    setPaneOverrides: ReturnType<typeof vi.fn>;
    setPanePick: ReturnType<typeof vi.fn>;
    setPaneTarget: ReturnType<typeof vi.fn>;
  };
  lineup?: RecoveryPane[];
  lineupResolutions?: PlaygroundClientResolution[];
  environments?: ComparePaneTargetOption[];
  paneEnvironments?: ReadonlyMap<string, ComparePaneEnvironment>;
}) {
  const controls = useComparePaneControls({
    active: true,
    panes: lineup.map((pane) => ({ ...pane, ...overrides[pane.paneId] })),
    resolutions: lineupResolutions,
    sharedServers: ["GitHub", "Docs"],
    serverIdByName,
    orgConfig: undefined,
    sections,
    targets: { clients: clientTargets, environments },
    paneEnvironments,
    ...spies,
  });
  const header = controls.renderPaneHeader(paneId)?.(lane);
  const servers = controls.paneServers(paneId);
  const composer = controls.composerServers(paneId);
  return (
    <div>
      {header?.actions}
      {header?.summary}
      <output data-testid="servers">{JSON.stringify(servers)}</output>
      <output data-testid="request">
        {JSON.stringify(controls.paneRequest(paneId, ["chat-1"]))}
      </output>
      <output data-testid="composer">
        {JSON.stringify(
          composer && {
            servers: composer.environmentServers,
            overridden: composer.environmentServersOverridden,
          },
        )}
      </output>
    </div>
  );
}

function spies() {
  return {
    restorePanes: vi.fn(),
    setPaneOverrides: vi.fn(),
    setPanePick: vi.fn(),
    setPaneTarget: vi.fn(),
  };
}

describe("Compare pane settings", () => {
  beforeEach(() => {
    useComparePaneStore.setState({ panes: [], selectedPaneId: null });
  });

  it.each([false, undefined])("offers only clients for a hidden saved pane (%s)", async (visible) => {
    const pane: RecoveryPane = {
      paneId: "restored",
      target: { kind: "environment", environmentId: "private" },
    };
    const environment = { environmentId: "private", visible, preview: null, isLoading: false, error: null };
    const resolution = resolveEnvironmentPaneColumn({
      paneId: pane.paneId, index: 1, environment, slot: undefined, hosts: [], models: catalog,
    });
    expect(resolution.status).toBe(visible === false ? "unavailable" : "loading");
    expect(resolution.status !== "ready" && resolution.reason).not.toMatch(/environment/i);
    const user = userEvent.setup();
    render(<Harness paneId={pane.paneId} spies={spies()} lineup={[panes[0], pane]}
      lineupResolutions={[resolutions[0], resolution]} paneEnvironments={new Map([[pane.paneId, environment]])} />);
    await user.click(screen.getByRole("button", { name: "Pane settings for Pane 2" }));
    const settings = screen.getByTestId("compare-pane-settings");
    expect(settings).not.toHaveTextContent(/environment/i);
    const select = within(settings).getByRole("combobox", { name: "What Pane 2 runs" });
    expect(select).toHaveTextContent("Choose a client");
    await user.click(select);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["codex", "cursor"]);
  });

  it("turns a server off for one pane only, and back to following the chat", async () => {
    const user = userEvent.setup();
    const calls = spies();
    const { rerender } = render(<Harness paneId="codex" spies={calls} />);
    await user.click(
      screen.getByRole("button", { name: "Pane settings for codex" }),
    );
    await user.click(screen.getByRole("switch", { name: "Use Docs in codex" }));
    expect(calls.setPaneOverrides).toHaveBeenCalledWith("codex", {
      serverIds: ["srv-github"],
    });

    rerender(
      <Harness
        paneId="codex"
        overrides={{ codex: { serverIds: ["srv-github"] } }}
        spies={calls}
      />,
    );
    expect(screen.getByTestId("servers").textContent).toBe(
      JSON.stringify({ names: ["GitHub"], ids: ["srv-github"] }),
    );
    expect(screen.getByTestId("compare-pane-summary")).toHaveTextContent(
      "1 server",
    );
    await user.click(screen.getByRole("switch", { name: "Use Docs in codex" }));
    expect(calls.setPaneOverrides).toHaveBeenLastCalledWith("codex", {
      serverIds: null,
    });
  });

  it("leaves a pane that follows the chat on the chat's servers", () => {
    render(<Harness paneId="cursor" spies={spies()} />);
    expect(screen.getByTestId("servers").textContent).toBe("null");
    expect(screen.getByTestId("compare-pane-summary")).toHaveTextContent(
      "2 servers",
    );
  });

  it("moves a pane and keeps the first pane from moving left", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness paneId="codex" spies={calls} />);
    await user.click(
      screen.getByRole("button", { name: "Pane settings for codex" }),
    );
    expect(screen.getByRole("button", { name: /Move left/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Move right/ }));
    expect(calls.restorePanes).toHaveBeenCalledWith([panes[1], panes[0]]);
  });

  it("shows Cursor Auto as fixed, with no model menu or effort", async () => {
    const user = userEvent.setup();
    render(<Harness paneId="cursor" spies={spies()} />);
    expect(screen.getByTestId("compare-pane-summary")).toHaveTextContent(
      "Chosen by Cursor CLI",
    );
    await user.click(
      screen.getByRole("button", { name: "Pane settings for cursor" }),
    );
    const settings = screen.getByTestId("compare-pane-settings");
    expect(within(settings).getByText("Cursor Auto")).toBeInTheDocument();
    expect(
      within(settings).queryByRole("button", { name: "Model for cursor" }),
    ).toBeNull();
  });

  it("offers only the rows the pane's harness runs, and picks one for that pane", async () => {
    const user = userEvent.setup();
    const calls = spies();
    render(<Harness paneId="codex" spies={calls} />);
    await user.click(
      screen.getByRole("button", { name: "Pane settings for codex" }),
    );
    await user.click(screen.getByRole("button", { name: "Model for codex" }));
    expect(screen.queryByText("anthropic/claude-haiku-4.5")).toBeNull();
    await user.click(await screen.findByText("openai/gpt-5-mini"));
    expect(calls.setPanePick).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        source: "hosted",
        modelId: "openai/gpt-5-mini",
      }),
    );
  });

  it("publishes the panes for the sidebar and selects the one whose settings open", async () => {
    const user = userEvent.setup();
    render(<Harness paneId="cursor" spies={spies()} />);
    expect(useComparePaneStore.getState().panes).toEqual([
      {
        paneId: "codex",
        label: "codex",
        hostId: "codex",
        environmentId: null,
        serverNames: null,
      },
      {
        paneId: "cursor",
        label: "cursor",
        hostId: "cursor",
        environmentId: null,
        serverNames: null,
      },
    ]);
    expect(useComparePaneStore.getState().selectedPaneId).toBe("codex");
    await user.click(
      screen.getByRole("button", { name: "Pane settings for cursor" }),
    );
    expect(useComparePaneStore.getState().selectedPaneId).toBe("cursor");
  });

  it("hands later sections the pane and the lane its card composed", async () => {
    const user = userEvent.setup();
    const sections = vi.fn<ComparePaneSections>(() => <p>Skills section</p>);
    render(
      <Harness
        paneId="codex"
        lane={{ environmentId: "hidden-env", pending: false }}
        sections={sections}
        spies={spies()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Pane settings for codex" }),
    );
    expect(screen.getByText("Skills section")).toBeInTheDocument();
    expect(sections).toHaveBeenCalledWith({
      pane: panes[0],
      lane: { environmentId: "hidden-env", pending: false },
    });
  });

  it("opens from the keyboard and closes with Escape", async () => {
    const user = userEvent.setup();
    render(<Harness paneId="codex" spies={spies()} />);
    const trigger = screen.getByRole("button", {
      name: "Pane settings for codex",
    });
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("compare-pane-settings")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("compare-pane-settings")).toBeNull();
  });

  describe("environment panes", () => {
    const envPane: RecoveryPane = {
      paneId: "env_1",
      target: { kind: "environment", environmentId: "env_1" },
    };
    const environment: ComparePaneEnvironment = {
      environmentId: "env_1",
      visible: true,
      isLoading: false,
      error: null,
      preview: {
        specVersion: 1,
        environment: { environmentId: "env_1", name: "E1", revision: 1 },
        host: {
          hostId: "codex",
          hostName: "Codex",
          hostConfigId: "cfg",
          modelId: "openai/gpt-5-mini",
          hostStyle: null,
          harness: "codex",
        },
        servers: [
          { serverId: "srv-linear", name: "Linear", source: "host_or_group" },
          { serverId: "srv-notion", name: "Notion", source: "plugin" },
        ],
        skills: [],
        plugins: [],
        capabilities: {
          requireToolApproval: null,
          respectToolVisibility: null,
          progressiveToolDiscovery: null,
          builtInToolIds: [],
          hasComputer: false,
          serverCount: 2,
          skillCount: 0,
          skillDelivery: "emulated",
          pluginCount: 0,
          serversOverridden: false,
        },
      },
    };
    const envResolution = resolveEnvironmentPaneColumn({
      paneId: "env_1",
      index: 1,
      environment,
      slot: { host: codex, isLoading: false },
      hosts: [],
      models: catalog,
    });

    function EnvHarness(
      props: Partial<Parameters<typeof Harness>[0]> & {
        spies: ReturnType<typeof spies>;
      },
    ) {
      return (
        <Harness
          paneId="env_1"
          lineup={[envPane, panes[1]]}
          lineupResolutions={[envResolution, resolutions[1]]}
          paneEnvironments={new Map([["env_1", environment]])}
          environments={[{ target: envPane.target, label: "E1" }]}
          {...props}
        />
      );
    }

    it("lists the environment's servers and narrows them by id for this pane", async () => {
      const user = userEvent.setup();
      const calls = spies();
      const { rerender } = render(<EnvHarness spies={calls} />);
      await user.click(
        screen.getByRole("button", { name: "Pane settings for E1" }),
      );
      const settings = screen.getByTestId("compare-pane-settings");
      expect(
        within(settings).getByText("Servers in this environment"),
      ).toBeTruthy();
      await user.click(
        within(settings).getByRole("switch", { name: "Use Notion in E1" }),
      );
      expect(calls.setPaneOverrides).toHaveBeenLastCalledWith("env_1", {
        serverIds: ["srv-linear"],
      });

      // Back to every server: follow the environment again.
      rerender(
        <EnvHarness
          spies={calls}
          overrides={{ env_1: { serverIds: ["srv-linear"] } }}
        />,
      );
      await user.click(
        within(settings).getByRole("switch", { name: "Use Notion in E1" }),
      );
      expect(calls.setPaneOverrides).toHaveBeenLastCalledWith("env_1", {
        serverIds: null,
      });

      // The last one off is an explicit "no servers", not "follow".
      await user.click(
        within(settings).getByRole("switch", { name: "Use Linear in E1" }),
      );
      expect(calls.setPaneOverrides).toHaveBeenLastCalledWith("env_1", {
        serverIds: [],
      });
      expect(screen.getByTestId("compare-pane-summary")).toHaveTextContent(
        "Codex · 1 server",
      );
    });

    it("sends the environment's pointer, and its narrowing only when it has one", () => {
      const calls = spies();
      const { rerender } = render(<EnvHarness spies={calls} />);
      const request = () =>
        JSON.parse(screen.getByTestId("request").textContent ?? "null");
      expect(request()).toEqual({
        selectedServerIds: ["chat-1"],
        executionTarget: { kind: "environment", environmentId: "env_1" },
        requiresWebChatApi: true,
        presentationHostId: "codex",
      });
      rerender(
        <EnvHarness
          spies={calls}
          overrides={{ env_1: { serverIds: [], pluginVersionIds: ["v1"] } }}
        />,
      );
      expect(request().environmentOverrides).toEqual({
        serverIds: [],
        pluginVersionIds: ["v1"],
      });
      // A client pane sends its client and none of this.
      rerender(<EnvHarness spies={calls} paneId="cursor" />);
      expect(request()).toEqual({
        selectedServerIds: ["chat-1"],
        hostId: "cursor",
      });
    });

    it("gives the composer this pane's environment rows, and the chat's rows to client panes", () => {
      const calls = spies();
      const { rerender } = render(
        <EnvHarness spies={calls} overrides={{ env_1: { serverIds: [] } }} />,
      );
      expect(
        JSON.parse(screen.getByTestId("composer").textContent ?? "null"),
      ).toEqual({
        servers: [
          {
            serverId: "srv-linear",
            name: "Linear",
            source: "host_or_group",
            enabled: false,
          },
          {
            serverId: "srv-notion",
            name: "Notion",
            source: "plugin",
            enabled: false,
          },
        ],
        overridden: true,
      });
      rerender(<EnvHarness spies={calls} paneId="cursor" />);
      expect(screen.getByTestId("composer").textContent).toBe("null");
    });

    it("runs a pane on an environment from its settings", async () => {
      const user = userEvent.setup();
      const calls = spies();
      render(<EnvHarness spies={calls} paneId="cursor" />);
      await user.click(
        screen.getByRole("button", { name: "Pane settings for cursor" }),
      );
      const settings = screen.getByTestId("compare-pane-settings");
      expect(within(settings).getByText("Client or environment")).toBeTruthy();
      await user.click(
        within(settings).getByRole("combobox", { name: "What cursor runs" }),
      );
      await user.click(screen.getByRole("option", { name: "E1" }));
      expect(calls.setPaneTarget).toHaveBeenCalledWith("cursor", {
        kind: "environment",
        environmentId: "env_1",
      });
    });

    it("publishes an environment pane for the Tools rail with its narrowing", () => {
      render(
        <EnvHarness spies={spies()} overrides={{ env_1: { serverIds: [] } }} />,
      );
      expect(useComparePaneStore.getState().panes[0]).toEqual({
        paneId: "env_1",
        label: "E1",
        hostId: "codex",
        environmentId: "env_1",
        environmentOverrides: { serverIds: [] },
        serverNames: null,
      });
    });
  });
});
