import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { ChatboxShareSection } from "../ChatboxShareSection";

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
    setChatboxMode: vi.fn(),
    updateChatbox: vi.fn(),
    upsertChatboxMember: vi.fn(),
    removeChatboxMember: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function createChatbox(overrides: Partial<ChatboxSettings> = {}): ChatboxSettings {
  return {
    chatboxId: "cb-1",
    workspaceId: "ws-1",
    name: "My Chatbox",
    hostStyle: "chatgpt",
    systemPrompt: "",
    modelId: "gpt-4",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "invited_only",
    servers: [],
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

describe("ChatboxShareSection", () => {
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
});
