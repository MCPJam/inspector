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
    projectId: "ws-1",
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
  it("renders the same section structure as the project share dialog", () => {
    render(
      <ChatboxShareSection chatbox={createChatbox()} projectName="Acme" />,
    );

    expect(screen.getByText("Tester link")).toBeInTheDocument();
    expect(screen.getByTestId("chatbox-copy-tester-link")).toBeInTheDocument();
    expect(screen.getByText("Invite with email")).toBeInTheDocument();
    expect(screen.getByText("Access settings")).toBeInTheDocument();
    expect(screen.getByText("Has access")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite", exact: true }),
    ).toBeInTheDocument();
  });

  // Opening a scenario to anyone with the link puts guest usage on the
  // organization's credits. There is no per-scenario cap editor any more (the
  // platform daily ceilings are the brake), so this line is the only place
  // that cost is disclosed — and it has to appear exactly where the exposure
  // is chosen.
  it("discloses guest credit usage only when link guest access is selected", () => {
    const creditNotice = /Guest usage runs on your organization's credits/i;
    const { rerender } = render(
      <ChatboxShareSection chatbox={createChatbox()} projectName="Acme" />,
    );

    expect(screen.queryByText(creditNotice)).not.toBeInTheDocument();

    rerender(
      <ChatboxShareSection
        chatbox={createChatbox({
          allowGuestAccess: true,
          mode: "anyone_with_link",
        })}
        projectName="Acme"
      />,
    );

    expect(screen.getByText(creditNotice)).toBeInTheDocument();
  });

  it("shows an Invited section when there are pending members", () => {
    const chatbox = createChatbox({
      members: [
        {
          _id: "m1",
          chatboxId: "cb-1",
          projectId: "ws-1",
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
