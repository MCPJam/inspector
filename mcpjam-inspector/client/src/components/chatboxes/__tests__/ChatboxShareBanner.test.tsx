import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  ChatboxShareBanner,
  ChatboxShareEmptyPanel,
} from "../ChatboxShareBanner";

const {
  authState,
  upsertChatboxMemberMock,
  copyToClipboardMock,
} = vi.hoisted(() => ({
  authState: { isAuthenticated: true },
  upsertChatboxMemberMock: vi.fn().mockResolvedValue(undefined),
  copyToClipboardMock: vi.fn(async () => true),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => authState,
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({
    upsertChatboxMember: upsertChatboxMemberMock,
  }),
}));

vi.mock("@/lib/chatbox-session", () => ({
  buildChatboxLink: (token: string) => `https://mcpjam.link/t/${token}`,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboardMock(...args),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const chatbox = {
  chatboxId: "cb-1",
  name: "Payments beta",
  link: { token: "tok", path: "/t/tok", url: "u", rotatedAt: 0, updatedAt: 0 },
} as unknown as ChatboxSettings;

beforeEach(() => {
  vi.clearAllMocks();
  authState.isAuthenticated = true;
  upsertChatboxMemberMock.mockResolvedValue(undefined);
  copyToClipboardMock.mockResolvedValue(true);
});

describe("ChatboxShareBanner", () => {
  it("renders the compact share strip when authenticated", () => {
    render(<ChatboxShareBanner chatbox={chatbox} />);

    expect(screen.getByTestId("user-testing-share-banner")).toBeInTheDocument();
    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
  });

  it("hides entirely when unauthenticated", () => {
    authState.isAuthenticated = false;
    const { container } = render(<ChatboxShareBanner chatbox={chatbox} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ChatboxShareEmptyPanel", () => {
  it("offers both a self-serve run and the share actions", () => {
    render(<ChatboxShareEmptyPanel chatbox={chatbox} />);

    expect(screen.getByTestId("user-testing-share-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Insights start with the first session/i),
    ).toBeInTheDocument();
    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
    expect(screen.getByText(/Try it yourself/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite by email" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
    const preview = screen.getByTestId("user-testing-share-empty-preview");
    expect(preview).toHaveAttribute("href", "https://mcpjam.link/t/tok");
    expect(preview).toHaveAttribute("target", "_blank");
  });

  it("does not restate the header banner's share headline", () => {
    render(<ChatboxShareEmptyPanel chatbox={chatbox} />);

    expect(
      screen.queryByText(/Share this with customers/i),
    ).not.toBeInTheDocument();
  });

  it("replaces the run affordance when the environment can't resolve", () => {
    render(
      <ChatboxShareEmptyPanel
        chatbox={
          {
            ...chatbox,
            environmentError: {
              code: "ENV_ARCHIVED",
              message: "Environment archived.",
            },
          } as ChatboxSettings
        }
      />,
    );

    expect(
      screen.queryByTestId("user-testing-share-empty-preview"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-share-empty-blocked"),
    ).toHaveTextContent(/environment isn't resolving/i);
  });

  it("still shows the link when unauthenticated, without invite", () => {
    authState.isAuthenticated = false;
    render(<ChatboxShareEmptyPanel chatbox={chatbox} />);

    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Invite by email" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
  });

  it("copies the share link from the empty panel", async () => {
    render(<ChatboxShareEmptyPanel chatbox={chatbox} />);

    fireEvent.click(screen.getByTestId("user-testing-share-empty-copy"));

    await waitFor(() =>
      expect(copyToClipboardMock).toHaveBeenCalledWith(
        "https://mcpjam.link/t/tok",
      ),
    );
  });
});
