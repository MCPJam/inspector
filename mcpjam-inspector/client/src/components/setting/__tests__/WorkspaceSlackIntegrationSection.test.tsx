import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSlackIntegrationSection } from "../WorkspaceSlackIntegrationSection";

const mockSignIn = vi.fn();
const mockConnectWebhook = vi.fn();
const mockSendTestMessage = vi.fn();
const mockDisconnect = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockUseConvexAuth = vi.fn();
const mockUseWorkspaceSlackIntegration = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    signIn: mockSignIn,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/hooks/useWorkspaceSlackIntegration", () => ({
  useWorkspaceSlackIntegration: (...args: unknown[]) =>
    mockUseWorkspaceSlackIntegration(...args),
}));

function renderSection(
  overrides: Partial<
    ComponentProps<typeof WorkspaceSlackIntegrationSection>
  > = {},
) {
  render(
    <WorkspaceSlackIntegrationSection
      workspaceId="ws-1"
      workspaceName="Acme"
      organizationId="org-1"
      canManageIntegration
      {...overrides}
    />,
  );
}

describe("WorkspaceSlackIntegrationSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });

    mockConnectWebhook.mockResolvedValue({
      workspaceId: "ws-1",
      connected: true,
    });
    mockSendTestMessage.mockResolvedValue({
      workspaceId: "ws-1",
      connected: true,
    });
    mockDisconnect.mockResolvedValue({
      workspaceId: "ws-1",
      connected: false,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestError: null,
      updatedAt: null,
    });

    mockUseWorkspaceSlackIntegration.mockReturnValue({
      status: {
        workspaceId: "ws-1",
        connected: false,
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestError: null,
        updatedAt: null,
      },
      error: null,
      isLoadingStatus: false,
      isConnecting: false,
      isSendingTest: false,
      isDisconnecting: false,
      connectWebhook: mockConnectWebhook,
      sendTestMessage: mockSendTestMessage,
      disconnect: mockDisconnect,
    });
  });

  it("shows a sign-in state for unauthenticated users", async () => {
    const user = userEvent.setup();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });

    renderSection();

    expect(
      screen.getByText(/Sign in to connect this workspace/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a synced-workspace note when the workspace is not shared in MCPJam", () => {
    renderSection({
      workspaceId: null,
      organizationId: undefined,
    });

    expect(
      screen.getByText(
        /Slack integrations are available after this workspace is synced/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Slack" }),
    ).not.toBeInTheDocument();
  });

  it("shows a read-only note for non-admin members", () => {
    renderSection({
      canManageIntegration: false,
    });

    expect(
      screen.getByText(/Only workspace admins can manage Slack integrations/i),
    ).toBeInTheDocument();
  });

  it("connects Slack from the disconnected state", async () => {
    const user = userEvent.setup();
    renderSection();

    const input = screen.getByPlaceholderText(
      "https://hooks.slack.com/services/...",
    );
    await user.type(input, "https://hooks.slack.com/services/T/B/C");
    await user.click(screen.getByRole("button", { name: "Connect Slack" }));

    await waitFor(() => {
      expect(mockConnectWebhook).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T/B/C",
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Slack connected");
  });

  it("renders connected actions and supports replace, test, and disconnect flows", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceSlackIntegration.mockReturnValue({
      status: {
        workspaceId: "ws-1",
        connected: true,
        lastTestedAt: 1_764_000_000_000,
        lastTestStatus: "failure",
        lastTestError: "Slack rejected the webhook request",
        updatedAt: 1_764_000_000_000,
      },
      error: null,
      isLoadingStatus: false,
      isConnecting: false,
      isSendingTest: false,
      isDisconnecting: false,
      connectWebhook: mockConnectWebhook,
      sendTestMessage: mockSendTestMessage,
      disconnect: mockDisconnect,
    });

    renderSection();

    expect(
      screen.queryByPlaceholderText("https://hooks.slack.com/services/..."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Slack rejected the webhook request"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => {
      expect(mockSendTestMessage).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: "Replace webhook" }));
    const input = screen.getByPlaceholderText(
      "https://hooks.slack.com/services/...",
    );
    await user.type(input, "https://hooks.slack.com/services/T/B/NEW");
    await user.click(screen.getByRole("button", { name: "Save webhook" }));

    await waitFor(() => {
      expect(mockConnectWebhook).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T/B/NEW",
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Slack webhook updated");

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirmDialog = screen.getByRole("alertdialog");
    await user.click(
      within(confirmDialog).getByRole("button", { name: "Disconnect" }),
    );

    await waitFor(() => {
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Slack disconnected");
  });
});
