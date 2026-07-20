/**
 * HostsTab agent bridge handlers (S4). Commands are dispatched through the real
 * command bus against a mounted HostsTab; the host mutations, project servers,
 * and template catalog are mocked so the handlers act through the SAME
 * useHostMutations callbacks the buttons/dialogs use.
 *
 * Findings this pins:
 * - create seeds from the live template catalog and selects the new host;
 * - set-servers resolves NAMES → ids against the project's servers and refuses
 *   an unknown name without touching the mutation;
 * - delete maps to deleteHost; unknown host → invalid_request;
 * - the snapshot reports redacted state and NEVER the system-prompt text.
 */
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const SYSTEM_PROMPT = "SECRET internal operator instructions — do not leak";

const hostA = {
  hostId: "host-1",
  name: "Claude",
  hostConfigId: "cfg-1",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 1,
  createdAt: 0,
  updatedAt: 0,
};
const hostB = {
  hostId: "host-2",
  name: "Cursor",
  hostConfigId: "cfg-2",
  modelId: "anthropic/claude-sonnet-4.5",
  serverCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

const hostDetail = {
  hostId: "host-1",
  name: "Claude",
  config: {
    id: "cfg-1",
    schemaVersion: 2,
    hostStyle: "mcpjam",
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0.7,
    requireToolApproval: true,
    respectToolVisibility: true,
    serverIds: ["srv-1"],
    optionalServerIds: [],
    builtInToolIds: [],
    connectionDefaults: {},
    clientCapabilities: {},
    hostContext: {},
  },
};

const projectServers = [
  { _id: "srv-1", name: "Asana" },
  { _id: "srv-2", name: "GitHub" },
];

const {
  createHostMock,
  updateHostServersMock,
  deleteHostMock,
  duplicateHostMock,
  setPreviewedHostIdMock,
} = vi.hoisted(() => ({
  createHostMock: vi.fn(),
  updateHostServersMock: vi.fn(),
  deleteHostMock: vi.fn(),
  duplicateHostMock: vi.fn(),
  setPreviewedHostIdMock: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => ["host-1", setPreviewedHostIdMock],
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [hostA, hostB], isLoading: false }),
  useHost: ({ hostId }: { hostId: string | null }) => ({
    host: hostId === "host-1" ? hostDetail : null,
    isLoading: false,
  }),
  useHostMutations: () => ({
    createHost: createHostMock,
    updateHost: vi.fn(),
    updateHostServers: updateHostServersMock,
    deleteHost: deleteHostMock,
    duplicateHost: duplicateHostMock,
  }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectServers: () => ({
    servers: projectServers,
    serversRecord: {},
    isLoading: false,
    hasServers: true,
  }),
}));

vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({
    status: "live",
    catalog: { hosts: {} },
    version: 1,
    source: "backend",
  }),
}));

vi.mock("@mcpjam/sdk/host-compat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/sdk/host-compat")>()),
  // A minimal JSON template the create handler clones + seeds.
  getCatalogTemplate: (_catalog: unknown, id: string) =>
    id === "claude" || id === "mcpjam"
      ? {
          hostStyle: id,
          modelId: "anthropic/claude-haiku-4.5",
          systemPrompt: "",
          temperature: 0.7,
          requireToolApproval: true,
          respectToolVisibility: true,
          serverIds: [],
          optionalServerIds: [],
          builtInToolIds: [],
          connectionDefaults: {},
          clientCapabilities: {},
          hostContext: {},
        }
      : undefined,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: any) => unknown) =>
    selector({ themeMode: "dark" }),
}));

vi.mock("@/components/hosts/HostBuilderView", () => ({
  HostBuilderView: () => <div data-testid="mock-host-builder" />,
}));

vi.mock("@/components/hosts/ConnectViewHeader", () => ({
  ConnectViewHeader: ({ rightSlot }: { rightSlot?: React.ReactNode }) => (
    <div data-testid="mock-connect-header">{rightSlot}</div>
  ),
}));

vi.mock("framer-motion", () => {
  const makeMotion = (Tag: "div" | "span") =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(function Motion(
      props,
      ref,
    ) {
      const {
        initial: _i,
        animate: _a,
        exit: _e,
        transition: _t,
        layoutId: _l,
        whileHover: _wh,
        whileTap: _wt,
        ...rest
      } = props;
      return React.createElement(Tag, { ref, ...rest });
    });
  return {
    motion: { div: makeMotion("div"), span: makeMotion("span") },
    useReducedMotion: () => false,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { HostsTab } from "@/components/HostsTab";

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `hosts-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function renderHosts(props?: {
  selectedHostId?: string | null;
  onSelectHost?: (id: string | null) => void;
  isAuthenticated?: boolean;
  projectId?: string | null;
}) {
  const onSelectHost = props?.onSelectHost ?? vi.fn();
  render(
    <HostsTab
      projectId={props?.projectId ?? "proj-1"}
      isAuthenticated={props?.isAuthenticated ?? true}
      selectedHostId={props?.selectedHostId ?? null}
      onSelectHost={onSelectHost}
      serversTabElement={<div data-testid="servers-stub" />}
    />,
  );
  return { onSelectHost };
}

beforeEach(() => {
  vi.clearAllMocks();
  createHostMock.mockResolvedValue({
    hostId: "host-new",
    hostConfigId: "cfg-new",
    chatboxId: null,
  });
  updateHostServersMock.mockResolvedValue({ hostId: "host-1", hostConfigId: "cfg-1b" });
  deleteHostMock.mockResolvedValue(undefined);
  duplicateHostMock.mockResolvedValue({ hostId: "host-dup", hostConfigId: "cfg-dup" });
});

describe("HostsTab — agent bridge handlers", () => {
  it("createHost seeds from the template and selects the new host", async () => {
    const { onSelectHost } = renderHosts();

    const response = await dispatch({
      type: "createHost",
      payload: { name: "My Claude", template: "claude" },
    });

    expect(response).toMatchObject({
      status: "success",
      result: { status: "host_created", hostId: "host-new", template: "claude" },
    });
    expect(createHostMock).toHaveBeenCalledTimes(1);
    const arg = createHostMock.mock.calls[0]![0] as {
      projectId: string;
      name: string;
      input: { serverIds: string[]; hostStyle: string };
    };
    expect(arg.projectId).toBe("proj-1");
    expect(arg.name).toBe("My Claude");
    expect(arg.input.serverIds).toEqual([]);
    expect(arg.input.hostStyle).toBe("claude");
    expect(onSelectHost).toHaveBeenCalledWith("host-new");
    expect(setPreviewedHostIdMock).toHaveBeenCalledWith("host-new");
  });

  it("createHost rejects an unknown template without creating", async () => {
    renderHosts();
    const response = await dispatch({
      type: "createHost",
      payload: { name: "Weird", template: "not-a-template" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(createHostMock).not.toHaveBeenCalled();
  });

  it("openHostEditor selects the host and reports it — no mutation", async () => {
    const { onSelectHost } = renderHosts();
    const response = await dispatch({
      type: "openHostEditor",
      payload: { host: "Claude" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "editor_opened", hostId: "host-1" },
    });
    expect(onSelectHost).toHaveBeenCalledWith("host-1");
  });

  it("openHostEditor rejects an unknown host as invalid_request", async () => {
    renderHosts();
    const response = await dispatch({
      type: "openHostEditor",
      payload: { host: "Nope" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
  });

  it("setHostServers resolves names → ids against the project's servers", async () => {
    renderHosts();
    const response = await dispatch({
      type: "setHostServers",
      payload: { host: "Claude", servers: ["Asana", "GitHub"] },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "host_servers_set", serverCount: 2 },
    });
    expect(updateHostServersMock).toHaveBeenCalledWith({
      hostId: "host-1",
      serverIds: ["srv-1", "srv-2"],
    });
  });

  it("setHostServers rejects an unknown server name without touching the mutation", async () => {
    renderHosts();
    const response = await dispatch({
      type: "setHostServers",
      payload: { host: "Claude", servers: ["Asana", "Ghost"] },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(updateHostServersMock).not.toHaveBeenCalled();
  });

  it("deleteHost maps to the deleteHost mutation", async () => {
    renderHosts();
    const response = await dispatch({
      type: "deleteHost",
      payload: { host: "host-2" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "host_deleted", hostId: "host-2" },
    });
    expect(deleteHostMock).toHaveBeenCalledWith({ hostId: "host-2" });
  });

  it("duplicateHost maps to the duplicateHost mutation and opens the copy", async () => {
    const { onSelectHost } = renderHosts();
    const response = await dispatch({
      type: "duplicateHost",
      payload: { host: "Claude", name: "Claude copy" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "host_duplicated", hostId: "host-dup" },
    });
    expect(duplicateHostMock).toHaveBeenCalledWith({
      hostId: "host-1",
      name: "Claude copy",
    });
    expect(onSelectHost).toHaveBeenCalledWith("host-dup");
  });

  it("refuses every command as unsupported_in_mode when signed out", async () => {
    renderHosts({ isAuthenticated: false });
    const response = await dispatch({
      type: "deleteHost",
      payload: { host: "host-2" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(deleteHostMock).not.toHaveBeenCalled();
  });

  it("snapshot reports redacted state and NEVER the system-prompt text", async () => {
    renderHosts({ selectedHostId: "host-1" });

    const snapshot = await readSurfaceSnapshot("hosts");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        viewPhase: "host",
        selectedHostId: "host-1",
        hostCount: 2,
        hosts: [
          { id: "host-1", name: "Claude", serverCount: 1 },
          { id: "host-2", name: "Cursor" },
        ],
        projectServers: ["Asana", "GitHub"],
        focusedHost: {
          id: "host-1",
          modelId: "anthropic/claude-haiku-4.5",
          requireToolApproval: true,
          hasSystemPrompt: true,
          systemPromptLength: SYSTEM_PROMPT.length,
        },
      },
    });
    // The prompt TEXT must never appear anywhere in the serialized snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("SECRET internal");
  });
});
