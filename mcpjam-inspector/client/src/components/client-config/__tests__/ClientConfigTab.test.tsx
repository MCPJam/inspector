import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";
import { ClientConfigTab } from "../ClientConfigTab";
import {
  mergeWorkspaceClientCapabilities,
  type WorkspaceConnectionConfigDraft,
} from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
}));

function resetClientConfigStore(defaultConfig: WorkspaceConnectionConfigDraft) {
  useClientConfigStore.setState({
    activeWorkspaceId: "workspace-1",
    defaultConfig,
    savedConfig: undefined,
    draftConfig: defaultConfig,
    connectionDefaultsText: JSON.stringify(
      defaultConfig.connectionDefaults ?? { headers: {}, requestTimeout: 10000 },
      null,
      2,
    ),
    clientCapabilitiesText: JSON.stringify(
      defaultConfig.clientCapabilities,
      null,
      2,
    ),
    connectionDefaultsError: null,
    clientCapabilitiesError: null,
    isSaving: false,
    isDirty: false,
    pendingWorkspaceId: null,
    pendingSavedConfig: undefined,
    isAwaitingRemoteEcho: false,
  });
}

describe("ClientConfigTab reconnect warnings", () => {
  beforeEach(() => {
    const defaultConfig: WorkspaceConnectionConfigDraft = {
      version: 1,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: getDefaultClientCapabilities() as Record<
        string,
        unknown
      >,
    };

    resetClientConfigStore(defaultConfig);
    useHostContextStore.setState({
      pendingWorkspaceId: null,
      isAwaitingRemoteEcho: false,
      isSaving: false,
    });
  });

  it("renders only connection-level JSON editors", () => {
    render(
      <ClientConfigTab
        activeWorkspaceId="workspace-1"
        workspace={undefined}
        onSaveClientConfig={vi.fn()}
      />,
    );

    expect(screen.getByText("Connection defaults")).toBeInTheDocument();
    expect(screen.getByText("Client capabilities")).toBeInTheDocument();
    expect(screen.queryByText("Host context")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("json-editor")).toHaveLength(2);
  });

  it("does not warn when server capability overrides already match the last initialize payload", () => {
    const serverCapabilities = {
      experimental: {
        serverOverride: { enabled: true },
      },
    };
    const initializedCapabilities = mergeWorkspaceClientCapabilities(
      getDefaultClientCapabilities() as Record<string, unknown>,
      serverCapabilities,
    );

    render(
      <ClientConfigTab
        activeWorkspaceId="workspace-1"
        workspace={{
          id: "workspace-1",
          name: "Workspace 1",
          servers: {
            "test-server": {
              name: "test-server",
              config: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-test"],
                capabilities: serverCapabilities,
              },
              lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
              connectionStatus: "connected",
              retryCount: 0,
              enabled: true,
              useOAuth: false,
              initializationInfo: {
                clientCapabilities: initializedCapabilities,
              } as any,
            },
          },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }}
        onSaveClientConfig={vi.fn()}
      />,
    );

    expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();
  });
});
