import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { ChatboxShareSection } from "../ChatboxShareSection";

const mockSetChatboxMode = vi.fn();
const mockUpdateChatbox = vi.fn();
const mockUpsertChatboxMember = vi.fn();
const mockRemoveChatboxMember = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
    },
  }),
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: null }),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({
    setChatboxMode: mockSetChatboxMode,
    updateChatbox: mockUpdateChatbox,
    upsertChatboxMember: mockUpsertChatboxMember,
    removeChatboxMember: mockRemoveChatboxMember,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function createServers() {
  return [
    {
      serverId: "server-required",
      serverName: "Required Server",
      useOAuth: false,
      serverUrl: "https://required.example.com",
      clientId: null,
      oauthScopes: null,
    },
    {
      serverId: "server-optional",
      serverName: "Optional Server",
      useOAuth: false,
      serverUrl: "https://optional.example.com",
      clientId: null,
      oauthScopes: null,
      optional: true,
    },
  ];
}

function createChatbox(overrides: Partial<ChatboxSettings> = {}): ChatboxSettings {
  return {
    chatboxId: "cb-1",
    workspaceId: "ws-1",
    name: "My Chatbox",
    description: "Chatbox description",
    hostStyle: "chatgpt",
    systemPrompt: "You are helpful.",
    modelId: "gpt-4",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "invited_only",
    servers: createServers(),
    link: {
      token: "t",
      path: "/c/t",
      url: "https://example.com/c/t",
      rotatedAt: 0,
      updatedAt: 0,
    },
    members: [],
    ...overrides,
  };
}

function expectedUpdatePayload(
  chatbox: ChatboxSettings,
  allowGuestAccess: boolean,
) {
  return {
    chatboxId: chatbox.chatboxId,
    name: chatbox.name,
    description: chatbox.description,
    hostStyle: chatbox.hostStyle,
    systemPrompt: chatbox.systemPrompt,
    modelId: chatbox.modelId,
    temperature: chatbox.temperature,
    requireToolApproval: chatbox.requireToolApproval,
    serverIds: chatbox.servers.map((server) => server.serverId),
    optionalServerIds: chatbox.servers
      .filter((server) => server.optional)
      .map((server) => server.serverId),
    allowGuestAccess,
  };
}

describe("ChatboxShareSection", () => {
  beforeEach(() => {
    mockSetChatboxMode.mockReset();
    mockUpdateChatbox.mockReset();
    mockUpsertChatboxMember.mockReset();
    mockRemoveChatboxMember.mockReset();
  });

  it("renders the same section structure as the workspace share dialog", () => {
    render(
      <ChatboxShareSection chatbox={createChatbox()} workspaceName="Acme" />,
    );

    expect(screen.getByText("Invite with email")).toBeInTheDocument();
    expect(screen.getByText("Access settings")).toBeInTheDocument();
    expect(screen.getByText("Has access")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite", exact: true }),
    ).toBeInTheDocument();
  });

  it("shows an Invited section when there are pending members", () => {
    const chatbox = createChatbox({
      members: [
        {
          _id: "m1",
          chatboxId: "cb-1",
          workspaceId: "ws-1",
          email: "pending@example.com",
          role: "chat",
          invitedBy: "u1",
          invitedAt: 1,
          user: null,
        },
      ],
    });

    render(<ChatboxShareSection chatbox={chatbox} />);

    expect(screen.getByText("Invited")).toBeInTheDocument();
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
  });

  it("sends the full update payload after switching from guest link access to invited only", async () => {
    const user = userEvent.setup();
    const initialChatbox = createChatbox({
      mode: "any_signed_in_with_link",
      allowGuestAccess: true,
    });
    const modeUpdatedChatbox = createChatbox({
      ...initialChatbox,
      name: "Mode-updated Chatbox",
      description: "Updated from setChatboxMode",
      hostStyle: "claude",
      systemPrompt: "Updated system prompt",
      modelId: "claude-sonnet",
      temperature: 0.2,
      requireToolApproval: true,
      mode: "invited_only",
      allowGuestAccess: true,
      servers: [
        {
          serverId: "server-mode-required",
          serverName: "Mode Required Server",
          useOAuth: false,
          serverUrl: "https://mode-required.example.com",
          clientId: null,
          oauthScopes: null,
        },
        {
          serverId: "server-mode-optional",
          serverName: "Mode Optional Server",
          useOAuth: false,
          serverUrl: "https://mode-optional.example.com",
          clientId: null,
          oauthScopes: null,
          optional: true,
        },
      ],
    });
    const fullyUpdatedChatbox = createChatbox({
      ...modeUpdatedChatbox,
      allowGuestAccess: false,
    });
    const onUpdated = vi.fn();
    mockSetChatboxMode.mockResolvedValue(modeUpdatedChatbox);
    mockUpdateChatbox.mockResolvedValue(fullyUpdatedChatbox);

    render(
      <ChatboxShareSection
        chatbox={initialChatbox}
        onUpdated={onUpdated}
        workspaceName="Acme"
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Anyone with the link (guests included)",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: /Invited users only/i,
      }),
    );

    await waitFor(() => {
      expect(mockSetChatboxMode).toHaveBeenCalledWith({
        chatboxId: "cb-1",
        mode: "invited_only",
      });
    });
    expect(mockUpdateChatbox).toHaveBeenCalledWith(
      expectedUpdatePayload(modeUpdatedChatbox, false),
    );
    expect(mockSetChatboxMode).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith(fullyUpdatedChatbox);
    });
  });

  it("sends the full update payload when enabling guest link access", async () => {
    const user = userEvent.setup();
    const initialChatbox = createChatbox({
      mode: "any_signed_in_with_link",
      allowGuestAccess: false,
    });
    const updatedChatbox = createChatbox({
      ...initialChatbox,
      allowGuestAccess: true,
    });
    const onUpdated = vi.fn();
    mockUpdateChatbox.mockResolvedValue(updatedChatbox);

    render(
      <ChatboxShareSection
        chatbox={initialChatbox}
        onUpdated={onUpdated}
        workspaceName="Acme"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Acme" }));
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: /Anyone with the link \(guests included\)/i,
      }),
    );

    await waitFor(() => {
      expect(mockUpdateChatbox).toHaveBeenCalledWith(
        expectedUpdatePayload(initialChatbox, true),
      );
    });
    expect(mockSetChatboxMode).not.toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledWith(updatedChatbox);
  });

  it("sends the full update payload when disabling guest link access for workspace members", async () => {
    const user = userEvent.setup();
    const initialChatbox = createChatbox({
      mode: "any_signed_in_with_link",
      allowGuestAccess: true,
    });
    const updatedChatbox = createChatbox({
      ...initialChatbox,
      allowGuestAccess: false,
    });
    const onUpdated = vi.fn();
    mockUpdateChatbox.mockResolvedValue(updatedChatbox);

    render(
      <ChatboxShareSection
        chatbox={initialChatbox}
        onUpdated={onUpdated}
        workspaceName="Acme"
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Anyone with the link (guests included)",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: /Acme/i,
      }),
    );

    await waitFor(() => {
      expect(mockUpdateChatbox).toHaveBeenCalledWith(
        expectedUpdatePayload(initialChatbox, false),
      );
    });
    expect(mockSetChatboxMode).not.toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledWith(updatedChatbox);
  });
});
