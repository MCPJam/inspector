/**
 * A pre-registered target with no client id (INSPECTOR-CLIENT-2J3).
 *
 * The flow cannot obtain a client id on its own, so the tab says so up front
 * and, at the registration step, asks for the id instead of stepping the
 * machine into a failure it can already see coming.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthFlowTab } from "../OAuthFlowTab";
import type { ServerWithName } from "@/hooks/use-app-state";
import { createInspectorOAuthStateMachine } from "@/lib/oauth/debug-state-machine-adapter";

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

const flowStateSeed = vi.hoisted(() => ({
  currentStep: "metadata_discovery",
  isInitiatingAuth: false,
  httpHistory: [],
}));

vi.mock("@mcpjam/sdk/browser", () => ({
  EMPTY_OAUTH_FLOW_STATE: flowStateSeed,
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

const captureProfileModalProps = vi.hoisted(() => vi.fn());
vi.mock("../oauth/OAuthProfileModal", () => ({
  OAuthProfileModal: (props: unknown) => {
    captureProfileModalProps(props);
    return null;
  },
}));

type LoggerActions = {
  onContinue?: () => void;
  continueLabel?: string;
};
const captureLoggerActions = vi.hoisted(() => vi.fn());
vi.mock("../oauth/OAuthFlowLogger", () => ({
  OAuthFlowLogger: ({ actions }: { actions: LoggerActions }) => {
    captureLoggerActions(actions);
    return <div data-testid="oauth-flow-logger" />;
  },
}));

vi.mock("../oauth/RefreshTokensConfirmModal", () => ({
  RefreshTokensConfirmModal: () => null,
}));

function server(
  profile: Partial<NonNullable<ServerWithName["oauthFlowProfile"]>>,
): ServerWithName {
  return {
    name: "databricks",
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: true,
    lastConnectionTime: new Date("2024-01-01"),
    config: { url: "https://example.cloud.databricks.com/mcp" },
    oauthFlowProfile: {
      serverUrl: "https://example.cloud.databricks.com/mcp",
      clientId: "",
      clientSecret: "",
      scopes: "",
      customHeaders: [],
      protocolVersion: "2025-11-25",
      registrationStrategy: "preregistered",
      ...profile,
    },
  } as ServerWithName;
}

function renderTab(target: ServerWithName) {
  return render(
    <OAuthFlowTab
      serverConfigs={{ [target.name]: target }}
      selectedServerName={target.name}
      onSelectServer={vi.fn()}
    />,
  );
}

const lastActions = (): LoggerActions =>
  captureLoggerActions.mock.calls.at(-1)?.[0] ?? {};
const lastModalOpen = (): boolean =>
  (captureProfileModalProps.mock.calls.at(-1)?.[0] as { open: boolean })
    ?.open ?? false;

describe("OAuthFlowTab with a pre-registered target and no client id", () => {
  const proceedToNextStep = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    flowStateSeed.currentStep = "metadata_discovery";
    proceedToNextStep.mockReset();
    captureLoggerActions.mockClear();
    captureProfileModalProps.mockClear();
    vi.mocked(createInspectorOAuthStateMachine).mockReturnValue({
      proceedToNextStep,
    } as never);
  });

  it("says up front that a client id is missing", () => {
    renderTab(server({}));
    expect(
      screen.getByTestId("oauth-preregistered-missing-client-id"),
    ).toHaveTextContent("no client ID is saved");
  });

  it("opens the configuration from the notice", () => {
    renderTab(server({}));
    fireEvent.click(screen.getByRole("button", { name: "Add client ID" }));
    expect(lastModalOpen()).toBe(true);
  });

  it("still lets discovery run before registration", async () => {
    renderTab(server({}));
    expect(lastActions().continueLabel).toBe("Continue");
    await act(async () => {
      lastActions().onContinue?.();
    });
    expect(proceedToNextStep).toHaveBeenCalledTimes(1);
  });

  it("asks for the client id instead of running registration", async () => {
    flowStateSeed.currentStep = "received_authorization_server_metadata";
    renderTab(server({}));
    expect(lastActions().continueLabel).toBe("Add client ID");
    await act(async () => {
      lastActions().onContinue?.();
    });
    expect(proceedToNextStep).not.toHaveBeenCalled();
    expect(lastModalOpen()).toBe(true);
  });

  it("finds a client id kept in the stored client record", () => {
    localStorage.setItem(
      "mcp-client-databricks",
      JSON.stringify({ client_id: "stored-client" }),
    );
    flowStateSeed.currentStep = "received_authorization_server_metadata";
    renderTab(server({}));
    expect(
      screen.queryByTestId("oauth-preregistered-missing-client-id"),
    ).not.toBeInTheDocument();
    expect(lastActions().continueLabel).toBe("Continue");
  });

  it("stays quiet when the profile has a client id", () => {
    renderTab(server({ clientId: "client-123" }));
    expect(
      screen.queryByTestId("oauth-preregistered-missing-client-id"),
    ).not.toBeInTheDocument();
  });

  it("stays quiet for dynamic registration", () => {
    renderTab(server({ registrationStrategy: "dcr" }));
    expect(
      screen.queryByTestId("oauth-preregistered-missing-client-id"),
    ).not.toBeInTheDocument();
  });
});
