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

    // getByLabelText, not getByText: the "Tester link" label has to resolve to
    // a real labelable control, so the link reads as that label's value to
    // assistive tech instead of as unassociated text.
    // The path says User Testing too — the tester reads this URL, and a code
    // name in it is what SUTB-8 reported.
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "/user-testing/my-chatbox/t",
    );
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

  /**
   * The other end of "a scenario that cannot run must not be shareable": the
   * create flow refuses to publish without an environment, and a scenario whose
   * environment stops resolving stops issuing its link. Without this the amber
   * banner on the detail page sat next to a live Copy link button, so the only
   * person who found out was the tester who opened it.
   */
  it("withholds the tester link while the environment can't resolve", () => {
    const chatbox = createChatbox({
      environmentId: "env-1",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "This scenario's environment was archived.",
      },
    });

    render(<ChatboxShareSection chatbox={chatbox} projectName="Acme" />);

    // The withheld copy, not just the absence of the link: asserting a path is
    // missing would stay green if the path shape ever changed under it.
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "Withheld — this scenario can't run.",
    );
    expect(screen.getByTestId("chatbox-copy-tester-link")).toBeDisabled();
    // Inviting mails the same link out, so it is gated too.
    expect(
      screen.getByRole("button", { name: "Invite", exact: true }),
    ).toBeDisabled();
    // The backend's own reason, verbatim: "archived" and "its host is gone" send
    // the owner to different places.
    expect(screen.getByTestId("chatbox-share-unrunnable")).toHaveTextContent(
      "This scenario's environment was archived.",
    );
  });

  // A rebind is a legitimate way out of that state, so the gate has to be
  // derived from the live envelope rather than latched: the same token comes
  // back the moment the scenario points at an environment that resolves.
  it("issues the link again once the environment resolves", () => {
    const { rerender } = render(
      <ChatboxShareSection
        chatbox={createChatbox({
          environmentId: "env-1",
          environmentError: { code: "ENV_ARCHIVED", message: "Archived." },
        })}
      />,
    );
    expect(screen.getByTestId("chatbox-copy-tester-link")).toBeDisabled();

    rerender(
      <ChatboxShareSection
        chatbox={createChatbox({
          environmentId: "env-2",
          environmentError: null,
        })}
      />,
    );

    expect(screen.getByTestId("chatbox-copy-tester-link")).not.toBeDisabled();
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "/user-testing/my-chatbox/t",
    );
    expect(
      screen.queryByTestId("chatbox-share-unrunnable"),
    ).not.toBeInTheDocument();
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
