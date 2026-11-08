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
  return (
    <div>
      {header?.actions}
      {header?.summary}
      <output data-testid="servers">{JSON.stringify(servers)}</output>
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
      paneId: pane.paneId, environment, slot: undefined, hosts: [], models: catalog,
    });
    expect(resolution.status).toBe(visible === false ? "unavailable" : "loading");
    expect(resolution.status !== "ready" && resolution.reason).not.toMatch(/environment/i);
    const user = userEvent.setup();
    render(<Harness paneId={pane.paneId} spies={spies()} lineup={[panes[0], pane]}
      lineupResolutions={[resolutions[0], resolution]} paneEnvironments={new Map([[pane.paneId, environment]])} />);
    await user.click(screen.getByRole("button", { name: "Pane settings for Saved setup" }));
    const settings = screen.getByTestId("compare-pane-settings");
    expect(settings).not.toHaveTextContent(/environment/i);
    const select = within(settings).getByRole("combobox", { name: "What Saved setup runs" });
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
});
