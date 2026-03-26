import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthStateMachineFactoryConfig } from "@/lib/oauth/state-machines/factory";
import { OAuthFlowTab } from "../OAuthFlowTab";
import type { ServerWithName } from "@/hooks/use-app-state";

const {
  mockCreateOAuthStateMachine,
  mockProceedToNextStep,
  mockPosthogCapture,
  savedProfilePayload,
} = vi.hoisted(() => ({
  mockCreateOAuthStateMachine: vi.fn(),
  mockProceedToNextStep: vi.fn(),
  mockPosthogCapture: vi.fn(),
  savedProfilePayload: {
    formData: {
      name: "saved-target",
      type: "http",
      url: "https://saved.example.com/mcp",
      useOAuth: true,
    },
    profile: {
      serverUrl: "https://saved.example.com/mcp",
      clientId: "",
      clientSecret: "",
      scopes: "openid profile",
      customHeaders: [],
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
    },
  },
}));

class MockBroadcastChannel {
  public onmessage:
    | ((event: { data: unknown }) => void)
    | null = null;

  constructor(_name: string) {}

  close = vi.fn();
}

vi.mock("posthog-js", () => ({
  default: {
    capture: mockPosthogCapture,
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: () => "test",
  detectPlatform: () => "web",
}));

vi.mock("@/lib/oauth/state-machines/factory", () => ({
  createOAuthStateMachine: mockCreateOAuthStateMachine,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
  }: {
    children?: ReactNode;
  }) => <div>{children}</div>,
  ResizablePanel: ({
    children,
  }: {
    children?: ReactNode;
  }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/components/oauth/OAuthSequenceDiagram", () => ({
  OAuthSequenceDiagram: () => <div data-testid="oauth-sequence-diagram" />,
}));

vi.mock("@/components/oauth/OAuthFlowLogger", () => ({
  OAuthFlowLogger: ({
    oauthFlowState,
    summary,
    actions,
  }: {
    oauthFlowState: { currentStep: string };
    summary?: { serverUrl?: string; description: string };
    actions?: {
      onConfigure?: () => void | Promise<void>;
      showConfigureTarget?: boolean;
      showEditTarget?: boolean;
      onContinue?: () => void | Promise<void>;
      continueLabel?: string;
      onConnectServer?: () => void | Promise<void>;
      onRefreshTokens?: () => void | Promise<void>;
      onReset?: () => void | Promise<void>;
    };
  }) => {
    const hasProfile = Boolean(summary?.serverUrl);
    return (
      <div>
        <div data-testid="current-step">{oauthFlowState.currentStep}</div>
        <div data-testid="summary-text">
          {summary?.serverUrl || summary?.description}
        </div>
        {hasProfile && actions?.showEditTarget !== false && actions?.onConfigure && (
          <button type="button" onClick={() => actions.onConfigure?.()}>
            Edit
          </button>
        )}
        {!hasProfile &&
          actions?.showConfigureTarget !== false &&
          actions?.onConfigure && (
            <button type="button" onClick={() => actions.onConfigure?.()}>
              Configure Target
            </button>
          )}
        {actions?.onContinue && (
          <button type="button" onClick={() => actions.onContinue?.()}>
            {actions.continueLabel || "Continue"}
          </button>
        )}
        {actions?.onConnectServer && (
          <button type="button" onClick={() => actions.onConnectServer?.()}>
            Connect Server
          </button>
        )}
        {actions?.onRefreshTokens && (
          <button type="button" onClick={() => actions.onRefreshTokens?.()}>
            Refresh Tokens
          </button>
        )}
        {actions?.onReset && (
          <button type="button" onClick={() => actions.onReset?.()}>
            Reset
          </button>
        )}
      </div>
    );
  },
}));

vi.mock("@/components/oauth/OAuthAuthorizationModal", () => ({
  OAuthAuthorizationModal: ({
    open,
    authorizationUrl,
  }: {
    open: boolean;
    authorizationUrl: string;
  }) =>
    open ? <div data-testid="auth-modal">{authorizationUrl}</div> : null,
}));

vi.mock("@/components/oauth/OAuthProfileModal", () => ({
  OAuthProfileModal: ({
    open,
    onSave,
  }: {
    open: boolean;
    onSave: (payload: typeof savedProfilePayload) => void;
  }) =>
    open ? (
      <div data-testid="profile-modal">
        <button type="button" onClick={() => onSave(savedProfilePayload)}>
          Save Target
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/oauth/RefreshTokensConfirmModal", () => ({
  RefreshTokensConfirmModal: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <div data-testid="refresh-modal">
        <button type="button" onClick={() => onConfirm()}>
          Confirm Refresh
        </button>
      </div>
    ) : null,
}));

const createHttpServer = (
  name: string,
  {
    status = "disconnected",
    url = `https://${name}.example.com/mcp`,
  }: {
    status?: ServerWithName["connectionStatus"];
    url?: string;
  } = {},
): ServerWithName =>
  ({
    name,
    config: {
      type: "http",
      url,
      headers: {},
    },
    oauthFlowProfile: {
      serverUrl: url,
      clientId: "",
      clientSecret: "",
      scopes: "openid profile",
      customHeaders: [],
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
    },
    lastConnectionTime: new Date("2026-01-01T00:00:00Z"),
    connectionStatus: status,
    retryCount: 0,
  }) as ServerWithName;

const setupStateMachineMock = () => {
  mockCreateOAuthStateMachine.mockImplementation(
    (config: OAuthStateMachineFactoryConfig) => ({
      state: config.state,
      updateState: config.updateState,
      proceedToNextStep: mockProceedToNextStep.mockImplementation(async () => {
        const state = config.getState?.() ?? config.state;

        switch (state.currentStep) {
          case "idle":
            config.updateState({ currentStep: "generate_pkce_parameters" });
            break;
          case "generate_pkce_parameters":
            config.updateState({
              currentStep: "authorization_request",
              authorizationUrl: "https://auth.example.com/authorize",
              state: "expected-state",
            });
            break;
          case "authorization_request":
            config.updateState({
              currentStep: "complete",
              accessToken: "access-token",
              refreshToken: "refresh-token",
              tokenType: "Bearer",
              expiresIn: 3600,
            });
            break;
          default:
            break;
        }
      }),
      startGuidedFlow: vi.fn(),
      resetFlow: vi.fn(),
    }),
  );
};

async function advanceToAuthorization() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
  expect(screen.getByTestId("current-step")).toHaveTextContent(
    "generate_pkce_parameters",
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
  });
  expect(screen.getByTestId("current-step")).toHaveTextContent(
    "authorization_request",
  );
}

async function completeOAuthCallback() {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "OAUTH_CALLBACK",
          code: "oauth-code",
          state: "expected-state",
        },
      }),
    );
  });

  await act(async () => {
    vi.advanceTimersByTime(500);
  });
}

describe("OAuthFlowTab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCreateOAuthStateMachine.mockReset();
    mockProceedToNextStep.mockReset();
    mockPosthogCapture.mockReset();
    setupStateMachineMock();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens target configuration and saves a new OAuth debugger target", () => {
    const onSelectServer = vi.fn();
    const onSaveServerConfig = vi.fn();

    const { rerender } = render(
      <OAuthFlowTab
        serverConfigs={{}}
        selectedServerName="none"
        onSelectServer={onSelectServer}
        onSaveServerConfig={onSaveServerConfig}
      />,
    );

    expect(screen.getByTestId("profile-modal")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Target" }));

    expect(onSaveServerConfig).toHaveBeenCalledWith(
      savedProfilePayload.formData,
      { oauthProfile: savedProfilePayload.profile },
    );

    rerender(
      <OAuthFlowTab
        serverConfigs={{
          "saved-target": createHttpServer("saved-target", {
            url: savedProfilePayload.formData.url,
          }),
        }}
        selectedServerName="none"
        onSelectServer={onSelectServer}
        onSaveServerConfig={onSaveServerConfig}
      />,
    );

    expect(onSelectServer).toHaveBeenCalledWith("saved-target");
  });

  it("advances the debugger flow, opens auth, and applies tokens to a disconnected server", async () => {
    const onConnectWithTokens = vi.fn().mockResolvedValue(undefined);

    render(
      <OAuthFlowTab
        serverConfigs={{
          "server-one": createHttpServer("server-one"),
        }}
        selectedServerName="server-one"
        onSelectServer={vi.fn()}
        onConnectWithTokens={onConnectWithTokens}
      />,
    );

    await advanceToAuthorization();

    expect(screen.getByTestId("auth-modal")).toHaveTextContent(
      "https://auth.example.com/authorize",
    );

    await completeOAuthCallback();

    expect(screen.queryByTestId("auth-modal")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Server" }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect Server" }));
    });

    expect(onConnectWithTokens).toHaveBeenCalledWith(
      "server-one",
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenType: "Bearer",
        expiresIn: 3600,
      }),
      "https://server-one.example.com/mcp",
    );
  });

  it("handles refresh-token application for connected servers", async () => {
    const onRefreshTokens = vi.fn().mockResolvedValue(undefined);

    render(
      <OAuthFlowTab
        serverConfigs={{
          "server-one": createHttpServer("server-one", {
            status: "connected",
          }),
        }}
        selectedServerName="server-one"
        onSelectServer={vi.fn()}
        onRefreshTokens={onRefreshTokens}
      />,
    );

    await advanceToAuthorization();
    await completeOAuthCallback();

    expect(
      screen.getByRole("button", { name: "Refresh Tokens" }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh Tokens" }));
    });
    expect(screen.getByTestId("refresh-modal")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Refresh" }));
    });

    expect(onRefreshTokens).toHaveBeenCalledWith(
      "server-one",
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenType: "Bearer",
        expiresIn: 3600,
      }),
      "https://server-one.example.com/mcp",
    );
  });

  it("resets the flow when the selected server changes", async () => {
    const serverOne = createHttpServer("server-one");
    const serverTwo = createHttpServer("server-two");

    const { rerender } = render(
      <OAuthFlowTab
        serverConfigs={{
          "server-one": serverOne,
          "server-two": serverTwo,
        }}
        selectedServerName="server-one"
        onSelectServer={vi.fn()}
      />,
    );

    await advanceToAuthorization();
    expect(screen.getByTestId("auth-modal")).toBeInTheDocument();

    rerender(
      <OAuthFlowTab
        serverConfigs={{
          "server-one": serverOne,
          "server-two": serverTwo,
        }}
        selectedServerName="server-two"
        onSelectServer={vi.fn()}
      />,
    );

    expect(screen.getByTestId("current-step")).toHaveTextContent("idle");
    expect(screen.queryByTestId("auth-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("summary-text")).toHaveTextContent(
      "https://server-two.example.com/mcp",
    );
  });
});
