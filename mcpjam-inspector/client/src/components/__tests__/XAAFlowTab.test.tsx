import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { XAAFlowTab } from "../xaa/XAAFlowTab";
import type { ServerWithName } from "@/hooks/use-app-state";

const captureMock = vi.fn();
vi.mock("posthog-js", () => ({
  default: {
    capture: (...args: unknown[]) => captureMock(...args),
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

vi.mock("../xaa/XAAIdpCard", () => ({
  XAAIdpCard: () => <div data-testid="xaa-idp-card" />,
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

vi.mock("../xaa/XAASequenceDiagram", () => ({
  XAASequenceDiagram: () => <div data-testid="xaa-sequence-diagram" />,
}));

vi.mock("../xaa/XAAFlowLogger", () => ({
  XAAFlowLogger: ({
    summary,
  }: {
    summary: { serverUrl?: string };
  }) => (
    <div data-testid="xaa-flow-logger">
      {summary.serverUrl || "No target configured"}
    </div>
  ),
}));

vi.mock("../xaa/XAAConfigModal", () => ({
  XAAConfigModal: () => null,
}));

vi.mock("../xaa/registration/XAAResourceAppsSection", () => ({
  XAAResourceAppsSection: () => <div data-testid="xaa-resource-apps-section" />,
}));

vi.mock("../xaa/XAABootstrapDialog", () => ({
  XAABootstrapDialog: () => null,
}));

vi.mock("@/lib/xaa/debug-state-machine-adapter", () => ({
  createInspectorXAAStateMachine: () => ({
    proceedToNextStep: vi.fn(),
  }),
}));

vi.mock("@/lib/xaa/profile", () => {
  const emptyProfile = {
    serverUrl: "",
    authzServerIssuer: "",
    negativeTestMode: "none",
    userId: "",
    email: "",
    clientId: "",
    scope: "",
  };

  return {
    loadStoredXAADebugProfile: () => emptyProfile,
    saveStoredXAADebugProfile: vi.fn(),
    deriveXAADebugProfileFromServer: (
      server: ServerWithName | undefined,
      fallback = emptyProfile,
    ) => ({
      ...fallback,
      serverUrl:
        server && "url" in server.config && server.config.url
          ? server.config.url.toString()
          : "",
    }),
  };
});

describe("XAAFlowTab", () => {
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

  it("shows no configured target when opened with a non-HTTP selection", () => {
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
      <XAAFlowTab
        serverConfigs={serverConfigs}
        selectedServerName="selected-stdio"
      />,
    );

    expect(screen.getByTestId("xaa-flow-logger")).toHaveTextContent(
      "No target configured",
    );
  });

  it("fires xaa_tab_viewed once per mount", () => {
    captureMock.mockClear();

    render(<XAAFlowTab serverConfigs={{}} selectedServerName="none" />);

    const viewedCalls = captureMock.mock.calls.filter(
      ([event]) => event === "xaa_tab_viewed",
    );
    expect(viewedCalls).toHaveLength(1);
    expect(viewedCalls[0][1]).toMatchObject({ location: "xaa_flow_tab" });
  });
});
