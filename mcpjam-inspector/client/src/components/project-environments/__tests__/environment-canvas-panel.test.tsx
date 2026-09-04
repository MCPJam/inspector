/**
 * EnvironmentCanvasPanel — the read-only Connect canvas embedded in the
 * environment detail view.
 *
 * The contract under test: the RESOLVED preview (not a client-side re-derivation
 * of the environment's picks) is what the canvas draws, the set it draws is
 * CLOSED (a project server outside the preview never gets a card), project
 * servers are consulted for the url join only, and every non-canvas state
 * (archived / error / loading / dangling host) keeps ReactFlow unmounted.
 *
 * The canvas + builder are the REAL modules here — both are pure and jsdom-safe,
 * as the existing `RedesignedHostCanvas` suite already proves. Only the data
 * hooks (network + Convex) are mocked.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import type { EnvironmentPreview } from "@/hooks/use-environment-preview";

const {
  mockPreview,
  mockRefresh,
  mockHost,
  mockHostList,
  mockProjectServers,
  mockNavigate,
  mockPreviewArgs,
} = vi.hoisted(() => ({
  mockPreview: {
    value: {
      preview: null as unknown,
      isLoading: false,
      error: null as string | null,
    },
  },
  mockRefresh: vi.fn(),
  mockHost: {
    value: { host: null as unknown, isLoading: false },
  },
  mockHostList: { value: [] as unknown[] },
  mockProjectServers: { value: [] as unknown[] },
  mockNavigate: vi.fn(),
  mockPreviewArgs: vi.fn(),
}));

vi.mock("@/hooks/use-environment-preview", () => ({
  useEnvironmentPreview: (
    projectId: string | null,
    environmentId: string | null,
    revision?: number | null
  ) => {
    mockPreviewArgs({ projectId, environmentId, revision });
    return { ...mockPreview.value, refresh: mockRefresh };
  },
}));
vi.mock("@/hooks/useClients", () => ({
  useHost: () => mockHost.value,
  useHostList: () => ({ hosts: mockHostList.value }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectServers: () => ({ servers: mockProjectServers.value }),
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
  buildHostsPath: (hostId: string) => `/hosts/${hostId}`,
}));

import {
  EnvironmentCanvasPanel,
  buildEnvironmentCanvasContext,
} from "../EnvironmentCanvasPanel";

const HOST_CONFIG = {
  ...emptyHostConfigInputV2(),
  id: "hc_1",
  schemaVersion: 2,
} as never;

const HOST = { hostId: "host-1", name: "Claude Code", config: HOST_CONFIG };

function previewWith(
  servers: Array<{ serverId: string; name: string; source: string | null }>
): EnvironmentPreview {
  return {
    specVersion: 1,
    environment: { environmentId: "env-1", name: "Prod-like", revision: 3 },
    host: {
      hostId: "host-1",
      hostName: "Claude Code",
      hostConfigId: "hc_1",
      modelId: null,
      hostStyle: null,
      harness: null,
    },
    servers,
    skills: [],
    plugins: [],
    capabilities: {
      requireToolApproval: null,
      respectToolVisibility: null,
      progressiveToolDiscovery: null,
      builtInToolIds: [],
      hasComputer: false,
      serverCount: servers.length,
      skillCount: 0,
      skillDelivery: "emulated",
      pluginCount: 0,
      serversOverridden: false,
    },
  } as EnvironmentPreview;
}

function renderPanel(overrides: Partial<{ isArchived: boolean }> = {}) {
  return render(
    <div style={{ width: 900, height: 700 }}>
      <EnvironmentCanvasPanel
        projectId="proj-1"
        environmentId="env-1"
        hostId="host-1"
        revision={3}
        isArchived={overrides.isArchived ?? false}
        isAuthenticated
      />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPreview.value = { preview: null, isLoading: false, error: null };
  mockHost.value = { host: HOST, isLoading: false };
  mockHostList.value = [];
  mockProjectServers.value = [];
});

describe("EnvironmentCanvasPanel — preview → canvas wiring", () => {
  it("uses the derived client display name", () => {
    mockPreview.value = {
      preview: previewWith([]),
      isLoading: false,
      error: null,
    };
    mockHostList.value = [
      { hostId: "host-1", name: "Claude Code", displayName: "Claude Code #2" },
    ];

    renderPanel();

    expect(screen.getByText("Claude Code #2")).toBeInTheDocument();
  });

  it("draws a card per RESOLVED server and joins urls from the project list", () => {
    mockPreview.value = {
      preview: previewWith([
        { serverId: "s1", name: "bench", source: "host_or_group" },
        { serverId: "p1", name: "plugin-server", source: "plugin" },
      ]),
      isLoading: false,
      error: null,
    };
    // The project list knows `s1` only — `p1` is plugin-contributed and has no
    // project row to join against.
    mockProjectServers.value = [
      { _id: "s1", name: "bench", url: "https://bench.example.com" },
    ];

    const { container } = renderPanel();

    const joined = container.querySelector(
      `.react-flow__node[data-id="server-card:s1"]`
    ) as HTMLElement | null;
    expect(joined).not.toBeNull();
    expect(joined!.textContent).toContain("https://bench.example.com");

    const nameOnly = container.querySelector(
      `.react-flow__node[data-id="server-card:p1"]`
    ) as HTMLElement | null;
    expect(nameOnly).not.toBeNull();
    expect(nameOnly!.textContent).toContain("plugin-server");
    expect(nameOnly!.textContent).not.toContain("https://");
  });

  it("renders a CLOSED set — a project server outside the preview gets no card", () => {
    mockPreview.value = {
      preview: previewWith([
        { serverId: "s1", name: "bench", source: "host_or_group" },
      ]),
      isLoading: false,
      error: null,
    };
    mockProjectServers.value = [
      { _id: "s1", name: "bench", url: "https://bench.example.com" },
      { _id: "s9", name: "not-a-member", url: "https://nope.example.com" },
    ];

    const { container } = renderPanel();

    expect(
      container.querySelector(`.react-flow__node[data-id="server-card:s1"]`)
    ).not.toBeNull();
    expect(
      container.querySelector(`.react-flow__node[data-id="server-card:s9"]`)
    ).toBeNull();
  });

  it("routes any canvas click to the host's Connect view", () => {
    mockPreview.value = {
      preview: previewWith([]),
      isLoading: false,
      error: null,
    };
    const { container } = renderPanel();

    const pane = container.querySelector(".react-flow__pane") as HTMLElement;
    fireEvent.click(pane);
    expect(mockNavigate).toHaveBeenCalledWith("/hosts/host-1");
  });
});

describe("buildEnvironmentCanvasContext", () => {
  it("makes every preview server required and implies no liveness", () => {
    const context = buildEnvironmentCanvasContext({
      hostName: "Claude Code",
      hostConfig: HOST_CONFIG,
      previewServers: [
        { serverId: "s1", name: "bench", source: "host_or_group" },
        { serverId: "p1", name: "plugin-server", source: "plugin" },
      ],
      projectServers: [
        { _id: "s1", name: "bench", url: "https://bench.example.com" },
        { _id: "s9", name: "not-a-member", url: "https://nope.example.com" },
      ] as never,
    });

    expect(context.draft.serverIds).toEqual(["s1", "p1"]);
    expect(context.draft.optionalServerIds).toEqual([]);
    // Closed set: built FROM the preview, never from the project list.
    expect(context.projectServers.map((s) => s.id)).toEqual(["s1", "p1"]);
    expect(context.projectServers[0].url).toBe("https://bench.example.com");
    expect(context.projectServers[1].url).toBeUndefined();
    // No liveness dot, no Computers islands.
    for (const server of context.projectServers) {
      expect(server.connectionStatus).toBeUndefined();
    }
    expect(context.computersEnabled).toBeUndefined();
    expect(context.isDirty).toBe(false);
    expect(context.savedSnapshotId).toBe("hc_1");
  });

  it("falls back to an empty host config when the host is gone", () => {
    const context = buildEnvironmentCanvasContext({
      hostName: "",
      hostConfig: null,
      previewServers: [],
      projectServers: undefined,
    });
    expect(context.savedSnapshotId).toBe("");
    expect(context.draft.serverIds).toEqual([]);
  });
});

describe("EnvironmentCanvasPanel — non-canvas states", () => {
  it("shows a spinner and mounts no ReactFlow while the preview resolves", () => {
    mockPreview.value = { preview: null, isLoading: true, error: null };
    const { container } = renderPanel();

    expect(screen.getByText(/resolving environment/i)).toBeInTheDocument();
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("offers a Retry that calls the hook's refresh on an error", () => {
    mockPreview.value = {
      preview: null,
      isLoading: false,
      error: { message: "This environment couldn't be resolved." },
    };
    const { container } = renderPanel();

    expect(
      screen.getByText("This environment couldn't be resolved.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("disables Retry while the same-key refetch is in flight", () => {
    // The hook keeps the stale `error` across a refetch, so the button is the
    // only place the click can show feedback.
    mockPreview.value = {
      preview: null,
      isLoading: true,
      error: { message: "This environment couldn't be resolved." },
    };
    renderPanel();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
  });

  it("shows archived copy off the ROW and never fires the doomed fetch", () => {
    // The preview endpoint 409s on archived environments; the copy is keyed on
    // the row, and the hook is passed a null environmentId so it stays idle.
    mockPreview.value = { preview: null, isLoading: false, error: null };
    const { container } = renderPanel({ isArchived: true });

    expect(screen.getByText(/archived/i)).toBeInTheDocument();
    expect(container.querySelector(".react-flow")).toBeNull();
    expect(mockPreviewArgs).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: null })
    );
  });

  it("reports a dangling host instead of spinning forever", () => {
    mockPreview.value = {
      preview: previewWith([]),
      isLoading: false,
      error: null,
    };
    mockHost.value = { host: null, isLoading: false };
    const { container } = renderPanel();

    expect(
      screen.getByText(/client behind this environment is no longer available/i)
    ).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("spins while the host query is still loading", () => {
    mockPreview.value = {
      preview: previewWith([]),
      isLoading: false,
      error: null,
    };
    mockHost.value = { host: null, isLoading: true };
    const { container } = renderPanel();

    expect(screen.getByText(/loading client/i)).toBeInTheDocument();
    expect(container.querySelector(".react-flow")).toBeNull();
  });
});
