import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";
import { ClientConfigTab } from "../ClientConfigTab";
import {
  mergeWorkspaceClientCapabilities,
  type WorkspaceClientConfig,
} from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
}));

function resetClientConfigStore(defaultConfig: WorkspaceClientConfig) {
  useClientConfigStore.setState({
    activeWorkspaceId: "workspace-1",
    defaultConfig,
    savedConfig: undefined,
    draftConfig: defaultConfig,
    clientCapabilitiesText: JSON.stringify(
      defaultConfig.clientCapabilities,
      null,
      2,
    ),
    hostContextText: JSON.stringify(defaultConfig.hostContext, null, 2),
    clientCapabilitiesError: null,
    hostContextError: null,
    isSaving: false,
    isDirty: false,
    pendingWorkspaceId: null,
    pendingSavedConfig: undefined,
    isAwaitingRemoteEcho: false,
  });
}

describe("ClientConfigTab reconnect warnings", () => {
  beforeEach(() => {
    const defaultConfig: WorkspaceClientConfig = {
      version: 1,
      clientCapabilities: getDefaultClientCapabilities() as Record<
        string,
        unknown
      >,
      hostContext: {},
    };

    resetClientConfigStore(defaultConfig);
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
