import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedServerChatPage } from "../SharedServerChatPage";
import {
  clearSharedServerSession,
  writeSharedServerSession,
} from "@/lib/shared-server-session";

const mockResolveShareForViewer = vi.fn();
const mockGetAccessToken = vi.fn();
const mockClipboardWriteText = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useMutation: () => mockResolveShareForViewer,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: vi.fn(),
}));

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: () => <div data-testid="shared-chat-tab" />,
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: vi.fn(() => null),
  initiateOAuth: vi.fn(async () => ({ success: false })),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

describe("SharedServerChatPage", () => {
  beforeEach(() => {
    clearSharedServerSession();
    mockResolveShareForViewer.mockReset();
    mockGetAccessToken.mockReset();
    mockClipboardWriteText.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockClipboardWriteText,
      },
    });
  });

  it("copies the full shared path link from the header", async () => {
    writeSharedServerSession({
      token: "token 123",
      payload: {
        workspaceId: "ws_1",
        serverId: "srv_1",
        serverName: "Server One",
        mode: "invited_only",
        viewerIsWorkspaceMember: false,
        useOAuth: false,
        serverUrl: null,
        clientId: null,
        oauthScopes: null,
      },
    });

    render(<SharedServerChatPage />);

    const copyButton = await screen.findByRole("button", { name: "Copy link" });
    await userEvent.click(copyButton);

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        `${window.location.origin}/shared/server-one/token%20123`,
      );
    });
    expect(toastSuccess).toHaveBeenCalledWith("Share link copied");
    expect(toastError).not.toHaveBeenCalled();
  });
});
