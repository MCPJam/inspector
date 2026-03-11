import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SandboxChatPage } from "../SandboxChatPage";
import {
  clearSandboxSession,
  writeSandboxSession,
} from "@/lib/sandbox-session";

const {
  mockGetAccessToken,
  mockSignIn,
  mockGetStoredTokens,
  mockInitiateOAuth,
} = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn(),
  mockSignIn: vi.fn(),
  mockGetStoredTokens: vi.fn(),
  mockInitiateOAuth: vi.fn(async () => ({ success: false })),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
    signIn: mockSignIn,
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: vi.fn(),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: () => <div data-testid="sandbox-chat-tab" />,
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: mockGetStoredTokens,
  initiateOAuth: mockInitiateOAuth,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("SandboxChatPage", () => {
  beforeEach(() => {
    clearSandboxSession();
    mockGetAccessToken.mockReset();
    mockSignIn.mockReset();
    mockGetStoredTokens.mockReset();
    mockInitiateOAuth.mockReset();

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockGetStoredTokens.mockReturnValue(null);
    mockInitiateOAuth.mockResolvedValue({ success: false });
  });

  it("applies sandbox host style data attributes and branding", async () => {
    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "ChatGPT Sandbox",
        description: "Hosted sandbox",
        hostStyle: "chatgpt",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    const { container } = render(<SandboxChatPage />);

    expect(await screen.findByTestId("sandbox-chat-tab")).toBeInTheDocument();
    expect(
      container.querySelector('[data-host-style="chatgpt"]'),
    ).toBeInTheDocument();
    expect(screen.getByAltText("ChatGPT")).toBeInTheDocument();
  });
});
