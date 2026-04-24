import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { OAuthFlowTab } from "../OAuthFlowTab";
import type { ServerWithName } from "@/hooks/use-app-state";

vi.mock("posthog-js", () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

vi.mock("@mcpjam/sdk/browser", () => ({
  EMPTY_OAUTH_FLOW_STATE: {
    currentStep: "metadata_discovery",
    isInitiatingAuth: false,
    httpHistory: [],
  },
}));

vi.mock("@/lib/oauth/debug-state-machine-adapter", () => ({
  createInspectorOAuthStateMachine: vi.fn(),
}));

vi.mock("@/components/oauth/OAuthSequenceDiagram", () => ({
  OAuthSequenceDiagram: () => <div data-testid="oauth-sequence-diagram" />,
}));

vi.mock("@/components/oauth/OAuthAuthorizationModal", () => ({
  OAuthAuthorizationModal: () => null,
}));

vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

vi.mock("../oauth/OAuthProfileModal", () => ({
  OAuthProfileModal: () => null,
}));

vi.mock("../oauth/OAuthFlowLogger", () => ({
  OAuthFlowLogger: ({
    summary,
  }: {
    summary: { label: string; description: string };
  }) => (
    <div data-testid="oauth-flow-logger">
      <div>{summary.label}</div>
      <div>{summary.description}</div>
    </div>
  ),
}));

vi.mock("../oauth/RefreshTokensConfirmModal", () => ({
  RefreshTokensConfirmModal: () => null,
}));

describe("OAuthFlowTab", () => {
  const createServer = (
    overrides: Partial<ServerWithName> = {},
  ): ServerWithName =>
    ({
      name: "test-server",
      connectionStatus: "connected",
      enabled: true,
      retryCount: 0,
      useOAuth: false,
      lastConnectionTime: new Date("2024-01-01"),
      config: {
        transportType: "stdio",
        command: "node",
        args: ["server.js"],
      },
      ...overrides,
    } as ServerWithName);

  it("does not select the first HTTP server when opened with a non-HTTP selection", async () => {
    const onSelectServer = vi.fn();
    const serverConfigs = {
      "selected-stdio": createServer({ name: "selected-stdio" }),
      "available-oauth": createServer({
        name: "available-oauth",
        useOAuth: true,
        config: {
          url: "https://example.com/mcp",
        },
      }),
    };

    render(
      <OAuthFlowTab
        serverConfigs={serverConfigs}
        selectedServerName="selected-stdio"
        onSelectServer={onSelectServer}
      />,
    );

    expect(screen.getByTestId("oauth-flow-logger")).toHaveTextContent(
      "No target configured",
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectServer).not.toHaveBeenCalled();
  });
});
