import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OAuthFlowExperience } from "../OAuthFlowExperience";
import type { OAuthFlowState } from "@/lib/oauth/state-machines/types";

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
  }: {
    children?: ReactNode;
  }) => <div data-testid="resizable-group">{children}</div>,
  ResizablePanel: ({
    children,
  }: {
    children?: ReactNode;
  }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/components/oauth/OAuthSequenceDiagram", () => ({
  OAuthSequenceDiagram: ({
    hasProfile,
  }: {
    hasProfile: boolean;
  }) => (
    <div data-testid="oauth-sequence-diagram">
      diagram-{hasProfile ? "configured" : "unconfigured"}
    </div>
  ),
}));

vi.mock("@/components/oauth/OAuthAuthorizationModal", () => ({
  OAuthAuthorizationModal: ({
    open,
    authorizationUrl,
  }: {
    open: boolean;
    authorizationUrl: string;
  }) =>
    open ? (
      <div data-testid="oauth-authorization-modal">{authorizationUrl}</div>
    ) : null,
}));

vi.mock("@/components/oauth/RefreshTokensConfirmModal", () => ({
  RefreshTokensConfirmModal: ({
    open,
    serverName,
  }: {
    open: boolean;
    serverName: string;
  }) =>
    open ? (
      <div data-testid="refresh-tokens-modal">{serverName}</div>
    ) : null,
}));

const baseFlowState: OAuthFlowState = {
  isInitiatingAuth: false,
  currentStep: "idle",
  httpHistory: [],
  infoLogs: [],
  tokenEndpointAuthMethod: undefined,
};

describe("OAuthFlowExperience", () => {
  it("renders the shared layout, summary, and server-backed actions", () => {
    const onConfigureTarget = vi.fn();
    const onContinue = vi.fn();
    const onApplyTokens = vi.fn();
    const onRefreshTokens = vi.fn();

    render(
      <OAuthFlowExperience
        flowState={baseFlowState}
        focusedStep={null}
        onFocusStep={vi.fn()}
        hasProfile={true}
        protocolVersion="2025-11-25"
        registrationStrategy="cimd"
        summary={{
          label: "Example Server",
          description: "Example OAuth target",
          protocol: "2025-11-25",
          registration: "CIMD (URL-based)",
          serverUrl: "https://example.com/mcp",
          scopes: "openid profile",
          clientId: "client-id",
        }}
        config={{
          targetMode: "server-backed",
        }}
        onClearLogs={vi.fn()}
        onClearHttpHistory={vi.fn()}
        onConfigureTarget={onConfigureTarget}
        onReset={vi.fn()}
        onContinue={onContinue}
        continueLabel="Continue"
        continueDisabled={false}
        onApplyTokens={onApplyTokens}
        onRefreshTokens={onRefreshTokens}
        isApplyingTokens={false}
        authModal={{
          open: true,
          onOpenChange: vi.fn(),
          authorizationUrl: "https://auth.example.com/authorize",
        }}
        refreshModal={{
          open: true,
          onOpenChange: vi.fn(),
          serverName: "Example Server",
          onConfirm: vi.fn(),
        }}
      />,
    );

    expect(screen.getByTestId("oauth-sequence-diagram")).toBeInTheDocument();
    expect(screen.getByTestId("resizable-group")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/mcp")).toBeInTheDocument();
    expect(screen.getByText("2025-11-25")).toBeInTheDocument();
    expect(screen.getByText("CIMD (URL-based)")).toBeInTheDocument();
    expect(screen.getByText("openid profile")).toBeInTheDocument();
    expect(screen.getByText("Client ID set")).toBeInTheDocument();
    expect(screen.getByTestId("oauth-authorization-modal")).toHaveTextContent(
      "https://auth.example.com/authorize",
    );
    expect(screen.getByTestId("refresh-tokens-modal")).toHaveTextContent(
      "Example Server",
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Server" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Tokens" }));

    expect(onConfigureTarget).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onApplyTokens).toHaveBeenCalledTimes(1);
    expect(onRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it("hides fixed-profile editing and token actions without forking the layout", () => {
    render(
      <OAuthFlowExperience
        flowState={baseFlowState}
        focusedStep={null}
        onFocusStep={vi.fn()}
        hasProfile={true}
        protocolVersion="2025-11-25"
        registrationStrategy="cimd"
        summary={{
          label: "Lesson Target",
          description: "Curated OAuth target",
          serverUrl: "https://lesson.example.com/mcp",
        }}
        config={{
          targetMode: "fixed-profile",
        }}
        onClearLogs={vi.fn()}
        onClearHttpHistory={vi.fn()}
        onConfigureTarget={vi.fn()}
        onReset={vi.fn()}
        onContinue={vi.fn()}
        continueLabel="Continue"
        continueDisabled={false}
        onApplyTokens={vi.fn()}
        onRefreshTokens={vi.fn()}
        authModal={{
          open: false,
          onOpenChange: vi.fn(),
          authorizationUrl: "https://auth.example.com/authorize",
        }}
        refreshModal={{
          open: true,
          onOpenChange: vi.fn(),
          serverName: "Lesson Target",
          onConfirm: vi.fn(),
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /edit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Server" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh Tokens" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("refresh-tokens-modal"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("shows or hides configure-target UI based on the experience mode", () => {
    const { rerender } = render(
      <OAuthFlowExperience
        flowState={baseFlowState}
        focusedStep={null}
        onFocusStep={vi.fn()}
        hasProfile={false}
        protocolVersion="2025-11-25"
        registrationStrategy="cimd"
        summary={{
          label: "No target",
          description: "Add an MCP base URL to begin.",
        }}
        config={{
          targetMode: "server-backed",
        }}
        onClearLogs={vi.fn()}
        onClearHttpHistory={vi.fn()}
        onConfigureTarget={vi.fn()}
        continueLabel="Configure Target"
        continueDisabled={true}
        authModal={{
          open: false,
          onOpenChange: vi.fn(),
        }}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Configure Target" })).not.toHaveLength(0);

    rerender(
      <OAuthFlowExperience
        flowState={baseFlowState}
        focusedStep={null}
        onFocusStep={vi.fn()}
        hasProfile={false}
        protocolVersion="2025-11-25"
        registrationStrategy="cimd"
        summary={{
          label: "Lesson Target",
          description: "Curated lesson target",
        }}
        config={{
          targetMode: "fixed-profile",
        }}
        onClearLogs={vi.fn()}
        onClearHttpHistory={vi.fn()}
        onConfigureTarget={vi.fn()}
        continueLabel="Continue"
        continueDisabled={true}
        authModal={{
          open: false,
          onOpenChange: vi.fn(),
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Configure Target" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Curated lesson target")).toBeInTheDocument();
  });
});
