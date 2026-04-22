import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { ChatboxBuilderView } from "../ChatboxBuilderView";
import { CHATBOX_STARTERS, toDraftConfig } from "../drafts";

const {
  mockUseChatbox,
  mockChatTabV2,
  mockCreateChatbox,
  mockUpdateChatbox,
  mockSetChatboxMode,
  mockUpsertChatboxMember,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockUseChatbox: vi.fn(() => ({ chatbox: null })),
  mockChatTabV2: vi.fn(),
  mockCreateChatbox: vi.fn(),
  mockUpdateChatbox: vi.fn(),
  mockSetChatboxMode: vi.fn(),
  mockUpsertChatboxMember: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: mockToastSuccess },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatbox: (...args: unknown[]) => mockUseChatbox(...args),
  useChatboxMutations: () => ({
    createChatbox: mockCreateChatbox,
    updateChatbox: mockUpdateChatbox,
    setChatboxMode: mockSetChatboxMode,
    upsertChatboxMember: mockUpsertChatboxMember,
  }),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useServerMutations: () => ({ createServer: vi.fn() }),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/lib/chatbox-host-style", () => ({
  getChatboxHostLogo: () => "/mock-host-logo.png",
  getChatboxHostStyleShortLabel: (hostStyle: string) =>
    hostStyle === "claude" ? "Claude" : "ChatGPT",
}));

vi.mock("@/hooks/hosted/use-hosted-oauth-gate", () => ({
  useHostedOAuthGate: () => ({
    oauthStateByServerId: {},
    pendingOAuthServers: [],
    authorizeServer: vi.fn(),
    markOAuthRequired: vi.fn(),
    hasBusyOAuth: false,
  }),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: () => null,
}));

vi.mock("@/lib/chatbox-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chatbox-session")>();
  return {
    ...actual,
    writeBuilderSession: vi.fn(),
    writePlaygroundSession: vi.fn(),
  };
});

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: (props: { loadingIndicatorVariant?: string }) => {
    mockChatTabV2(props);
    return <div data-testid="chat-tab" />;
  },
}));

vi.mock("@/components/connection/AddServerModal", () => ({
  AddServerModal: () => null,
}));

vi.mock("../ChatboxCanvas", () => ({
  ChatboxCanvas: () => <div data-testid="chatbox-canvas" />,
}));

vi.mock("@/components/chatboxes/ChatboxUsagePanel", () => ({
  ChatboxUsagePanel: ({
    section,
  }: {
    section: "sessions" | "insights";
  }) => (
    <div data-testid="chatbox-usage-panel" data-section={section} />
  ),
}));

const httpsServer = {
  _id: "srv-1",
  workspaceId: "ws-1",
  name: "Test MCP",
  enabled: true,
  transportType: "http" as const,
  url: "https://example.com/mcp",
  createdAt: 1,
  updatedAt: 1,
};

function createSavedChatbox(
  hostStyle: "claude" | "chatgpt",
  overrides: Partial<ChatboxSettings> = {},
): ChatboxSettings {
  return {
    chatboxId: `sbx-${hostStyle}`,
    workspaceId: "ws-1",
    name: `${hostStyle} chatbox`,
    description: "",
    hostStyle,
    systemPrompt: "You are helpful.",
    modelId: "openai/gpt-5-mini",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "any_signed_in_with_link" as const,
    servers: [],
    link: {
      token: `token-${hostStyle}`,
      path: `/chatbox/${hostStyle}`,
      url: `https://example.com/chatbox/${hostStyle}`,
      rotatedAt: 1,
    },
    members: [],
    welcomeDialog: { enabled: true, body: "" },
    feedbackDialog: {
      enabled: true,
      everyNToolCalls: 1,
      promptHint: "",
    },
    ...overrides,
  };
}

function createUnsavedInviteOnlyDraft() {
  return {
    ...CHATBOX_STARTERS.find((s) => s.id === "internal-qa")!.createDraft(
      "openai/gpt-5-mini",
    ),
    selectedServerIds: [httpsServer._id],
  };
}

describe("ChatboxBuilderView", () => {
  beforeEach(() => {
    mockUseChatbox.mockReset();
    mockUseChatbox.mockReturnValue({ chatbox: null });
    mockChatTabV2.mockReset();
    mockCreateChatbox.mockReset();
    mockUpdateChatbox.mockReset();
    mockSetChatboxMode.mockReset();
    mockUpsertChatboxMember.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it("shows Save changes on the header save button when a saved chatbox is dirty (no Unsaved badge)", () => {
    const chatbox = createSavedChatbox("claude");
    mockUseChatbox.mockReturnValue({ chatbox });
    const dirtyDraft = {
      ...toDraftConfig(chatbox),
      name: "Renamed in draft",
      selectedServerIds: [httpsServer._id],
    };
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        chatboxId={chatbox.chatboxId}
        draft={dirtyDraft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
  });

  it("exposes return navigation as an icon button with a descriptive label", () => {
    const draft = CHATBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Return to chatboxes" }),
    ).toBeInTheDocument();
  });

  it("shows setup-mode bottom CTA only in setup mode", () => {
    const draft = CHATBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    const cta = screen.getByRole("button", { name: "Save and open preview" });
    expect(cta).toBeInTheDocument();
    expect(cta).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
  });

  it("enables the setup bottom CTA when no setup sections need attention", () => {
    const base = CHATBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    const draft = {
      ...base,
      selectedServerIds: [httpsServer._id],
    };
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Save and open preview" }),
    ).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/i })).not.toBeDisabled();
  });

  it("creates the chatbox, sends the staged invite, and reopens Setup > Access on first save", async () => {
    const user = userEvent.setup();
    const createdChatbox = createSavedChatbox("claude", {
      name: "Internal QA",
      mode: "invited_only",
    });
    const onSavedDraft = vi.fn();
    mockCreateChatbox.mockResolvedValue(createdChatbox);
    mockUpsertChatboxMember.mockResolvedValue(undefined);

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={createUnsavedInviteOnlyDraft()}
        onBack={() => {}}
        onSavedDraft={onSavedDraft}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Access/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "tester@example.com" },
    });
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(mockCreateChatbox).toHaveBeenCalledTimes(1));
    expect(mockCreateChatbox).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        serverIds: [httpsServer._id],
      }),
    );
    expect(mockSetChatboxMode).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockUpsertChatboxMember).toHaveBeenCalledWith({
        chatboxId: createdChatbox.chatboxId,
        email: "tester@example.com",
        sendInviteEmail: true,
      }),
    );
    expect(mockCreateChatbox.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpsertChatboxMember.mock.invocationCallOrder[0],
    );
    await waitFor(() =>
      expect(onSavedDraft).toHaveBeenCalledWith(createdChatbox, {
        initialViewMode: "setup",
        initialFocusedSetupSection: "access",
      }),
    );
  });

  it("sends the staged invite before Save and open preview switches to preview", async () => {
    const user = userEvent.setup();
    const createdChatbox = createSavedChatbox("claude", {
      name: "Internal QA",
      mode: "invited_only",
    });
    const onSavedDraft = vi.fn();
    mockCreateChatbox.mockResolvedValue(createdChatbox);
    mockUpsertChatboxMember.mockResolvedValue(undefined);

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={createUnsavedInviteOnlyDraft()}
        onBack={() => {}}
        onSavedDraft={onSavedDraft}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Access/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "preview@example.com" },
    });
    await user.click(
      screen.getByRole("button", { name: "Save and open preview" }),
    );

    await waitFor(() => expect(mockCreateChatbox).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockUpsertChatboxMember).toHaveBeenCalledWith({
        chatboxId: createdChatbox.chatboxId,
        email: "preview@example.com",
        sendInviteEmail: true,
      }),
    );
    expect(mockCreateChatbox.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpsertChatboxMember.mock.invocationCallOrder[0],
    );
    await waitFor(() =>
      expect(onSavedDraft).toHaveBeenCalledWith(createdChatbox, {
        initialViewMode: "preview",
      }),
    );
  });

  it("keeps the staged invite email in place when save is blocked and does not attempt an invite", async () => {
    const user = userEvent.setup();
    const draft = CHATBOX_STARTERS.find((s) => s.id === "internal-qa")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Access/i }));
    const emailInput = screen.getByLabelText(/email address/i);
    fireEvent.change(emailInput, {
      target: { value: "blocked@example.com" },
    });

    const saveButton = screen.getByRole("button", { name: /^Save$/i });
    expect(saveButton).toBeDisabled();
    await user.click(saveButton);

    expect(emailInput).toHaveValue("blocked@example.com");
    expect(mockCreateChatbox).not.toHaveBeenCalled();
    expect(mockUpsertChatboxMember).not.toHaveBeenCalled();
  });

  it("keeps the created chatbox and reopens Setup > Access when the staged invite fails", async () => {
    const user = userEvent.setup();
    const createdChatbox = createSavedChatbox("claude", {
      name: "Internal QA",
      mode: "invited_only",
    });
    const onSavedDraft = vi.fn();
    mockCreateChatbox.mockResolvedValue(createdChatbox);
    mockUpsertChatboxMember.mockRejectedValue(new Error("Invite failed"));

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={createUnsavedInviteOnlyDraft()}
        onBack={() => {}}
        onSavedDraft={onSavedDraft}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Access/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "retry@example.com" },
    });
    await user.click(
      screen.getByRole("button", { name: "Save and open preview" }),
    );

    await waitFor(() => expect(mockCreateChatbox).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockUpsertChatboxMember).toHaveBeenCalledWith({
        chatboxId: createdChatbox.chatboxId,
        email: "retry@example.com",
        sendInviteEmail: true,
      }),
    );
    await waitFor(() =>
      expect(onSavedDraft).toHaveBeenCalledWith(createdChatbox, {
        initialViewMode: "setup",
        initialFocusedSetupSection: "access",
      }),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Chatbox created");
    expect(mockToastError).toHaveBeenCalledWith("Invite failed");
  });

  it("disables Preview, Sessions, and Clusters until the chatbox is saved", () => {
    const draft = CHATBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clusters" })).toBeDisabled();
  });

  it("passes sessions section to the usage panel for usage view mode", () => {
    const chatbox = createSavedChatbox("claude");
    mockUseChatbox.mockReturnValue({ chatbox });

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        chatboxId={chatbox.chatboxId}
        initialViewMode="usage"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByTestId("chatbox-usage-panel")).toHaveAttribute(
      "data-section",
      "sessions",
    );
  });

  it("passes insights section to the usage panel for insights view mode", () => {
    const chatbox = createSavedChatbox("claude");
    mockUseChatbox.mockReturnValue({ chatbox });

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        chatboxId={chatbox.chatboxId}
        initialViewMode="insights"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByTestId("chatbox-usage-panel")).toHaveAttribute(
      "data-section",
      "insights",
    );
  });

  it("renders the setup checklist on desktop while in setup mode", () => {
    const draft = CHATBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Basics/i })).toBeInTheDocument();
    expect(screen.getByTestId("chatbox-canvas")).toBeInTheDocument();
  });

  it("renders preview actions in the preview config rail", () => {
    const chatbox = createSavedChatbox("claude");
    mockUseChatbox.mockReturnValue({ chatbox });

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        chatboxId={chatbox.chatboxId}
        initialViewMode="preview"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    const rail = screen.getByTestId("chatbox-builder-preview-rail-actions");
    expect(
      within(rail).getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Open full preview" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Reload preview" }),
    ).toBeInTheDocument();
  });

  it("passes the pulsing dot loading variant for ChatGPT builder previews", () => {
    const chatbox = createSavedChatbox("chatgpt");
    mockUseChatbox.mockReturnValue({ chatbox });

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        chatboxId={chatbox.chatboxId}
        initialViewMode="preview"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByTestId("chat-tab")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingIndicatorVariant: "chatgpt-dot",
      }),
    );
  });

  it("passes the Claude mark variant to Claude builder previews", () => {
    const chatbox = createSavedChatbox("claude");
    mockUseChatbox.mockReturnValue({ chatbox });

    render(
      <ChatboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        chatboxId={chatbox.chatboxId}
        initialViewMode="preview"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByTestId("chat-tab")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingIndicatorVariant: "claude-mark",
      }),
    );
  });
});
