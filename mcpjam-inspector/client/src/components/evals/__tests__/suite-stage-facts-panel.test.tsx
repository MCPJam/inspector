import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { withDataRouter } from "./settings-sheet-harness";
import type { RemoteServer } from "@/hooks/useProjects";
import {
  SuiteStageFactsList,
  type StageFactsTarget,
} from "../suite-stage-facts-panel";

const hostConfig = {
  id: "hc-1",
  schemaVersion: 2,
  hostStyle: "mcpjam",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  serverIds: ["srv-1"],
  optionalServerIds: [],
  connectionDefaults: { headers: {}, requestTimeout: 30_000 },
  clientCapabilities: { roots: {} },
  hostContext: {},
};

// The panel reads its host through `useHost`, which is a Convex `useQuery`
// under a readiness gate. Mocking the hook rather than `convex/react` keeps
// the test about the panel instead of about Convex's auth plumbing.
const useHostMock = vi.fn();
vi.mock("@/hooks/useClients", () => ({
  useHost: (args: unknown) => useHostMock(args),
}));

// The path BUILDERS stay real — the point of these assertions is that the card
// sends a reader to the URL those helpers define, so stubbing them would let
// the panel and the routes drift apart while the test stayed green.
const navigateMock = vi.fn();
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigateMock,
}));

const servers: RemoteServer[] = [
  {
    _id: "srv-1",
    projectId: "p-1",
    name: "Server One",
    enabled: true,
    transportType: "http",
    url: "https://example.com/mcp",
    createdAt: 1,
    updatedAt: 1,
  },
];

const target: StageFactsTarget = {
  key: "env-1",
  label: "Claude · haiku",
  hostId: "host-1",
  environmentId: "env-1",
  attachment: null,
  servers: { kind: "host", extraIds: [] },
};

function renderList(
  overrides: Partial<React.ComponentProps<typeof SuiteStageFactsList>> = {},
) {
  const onGoToWhereItRuns = vi.fn();
  const result = render(
    withDataRouter(
      <SuiteStageFactsList
        stage="connection"
        targets={[target]}
        projectServers={servers}
        isAuthenticated
        composeCapable
        onGoToWhereItRuns={onGoToWhereItRuns}
        {...overrides}
      />,
    ),
  );
  return { ...result, onGoToWhereItRuns };
}

beforeEach(() => {
  navigateMock.mockReset();
  useHostMock.mockReset();
  useHostMock.mockReturnValue({
    host: { hostId: "host-1", name: "Claude", config: hostConfig },
    isLoading: false,
  });
});

describe("SuiteStageFactsList", () => {
  it("names the client, the server and what the run connects with", () => {
    const { container } = renderList();
    const text = container.textContent ?? "";
    expect(text).toContain("Claude · haiku");
    expect(text).toContain("Server One");
    expect(text).toContain("30 s");
    expect(
      container.querySelector('[data-stage-facts="connection"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-stage-facts-target="env-1"]'),
    ).toBeTruthy();
  });

  it("describes discovery from the same client", () => {
    const { container } = renderList({ stage: "discovery" });
    const text = container.textContent ?? "";
    expect(text).toContain("Pagination");
    expect(text).toContain("Tool visibility");
    expect(
      container.querySelector('[data-stage-facts="discovery"]'),
    ).toBeTruthy();
  });

  it("links out to the pages that own these values, and edits nothing here", () => {
    const { getByText, container } = renderList();

    fireEvent.click(getByText("Edit server"));
    expect(navigateMock).toHaveBeenCalledWith("/servers/srv-1");

    fireEvent.click(getByText("Edit client"));
    expect(navigateMock).toHaveBeenCalledWith("/hosts/host-1");

    fireEvent.click(getByText("Open environment"));
    expect(navigateMock).toHaveBeenCalledWith("/environments/env-1");

    // Read-only by design: these values are shared with every other suite
    // pointing at the same client or server.
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
  });

  it("describes a suite that runs under its own client, with no client to open", () => {
    // An attachment-less suite is still a run target: it executes under the
    // suite's own saved config (or the default MCPJam client). Reporting "no
    // run target yet" sent a reader to attach something the run does not need.
    const { container, queryByText } = renderList({
      targets: [
        {
          key: "suite-host",
          label: "This suite's own client",
          hostId: "",
          hostConfig: hostConfig as never,
          attachment: null,
          servers: { kind: "host", extraIds: [] },
        },
      ],
    });
    expect(container.textContent).toContain("This suite's own client");
    expect(container.textContent).toContain("Server One");
    expect(container.textContent).not.toContain("No run target yet");
    // There is no client ROW behind this config, so there is no page to open.
    expect(queryByText("Edit client")).toBeNull();
    // It never asks Convex for a host it has no id for.
    expect(useHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: null }),
    );
  });

  it("does not stamp a settings key the manifest ratchet would walk", () => {
    const { container } = renderList();
    expect(container.querySelector("[data-setting-key]")).toBeNull();
  });

  it("offers a way to Where it runs when nothing is attached", () => {
    const { getByText, onGoToWhereItRuns, container } = renderList({
      targets: [],
    });
    expect(container.textContent).toContain("No run target yet");
    fireEvent.click(getByText("Where it runs"));
    expect(onGoToWhereItRuns).toHaveBeenCalled();
  });

  it("says clients, not environments, on a deployment that cannot compose", () => {
    const { container } = renderList({ targets: [], composeCapable: false });
    expect(container.textContent).toContain("a client");
  });

  it("waits rather than claiming a server is gone while the list loads", () => {
    const { container } = renderList({ projectServers: undefined });
    expect(container.textContent).toContain("Loading client settings");
    expect(container.textContent).not.toContain("No longer in this project");
  });
});
