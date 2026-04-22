import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { ChatHistoryRow } from "../ChatHistoryRow";
import { getModelById } from "@/shared/types";

function sessionStub(
  overrides: Partial<ChatHistorySession> = {},
): ChatHistorySession {
  return {
    _id: "s1",
    chatSessionId: "chat-s1",
    firstMessagePreview: "hello world",
    status: "active",
    directVisibility: "private",
    messageCount: 1,
    version: 1,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    isPinned: false,
    manualUnread: false,
    isUnread: false,
    ...overrides,
  };
}

const actions = {
  rename: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  share: vi.fn(),
  unshare: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
};

vi.mock("@mcpjam/design-system/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

vi.mock("@mcpjam/design-system/input", () => ({
  Input: () => <input data-testid="rename-input" />,
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
  }: {
    children: ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
  TooltipContent: () => null,
}));

describe("ChatHistoryRow", () => {
  it("shows resolved model name when modelId matches catalog", () => {
    const session = sessionStub({ modelId: "openai/gpt-5-mini" });
    const def = getModelById("openai/gpt-5-mini");
    expect(def).toBeDefined();

    render(
      <ChatHistoryRow
        session={session}
        isActive={false}
        isAuthenticated={false}
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    const modelEl = screen.getByTestId("chat-history-model");
    expect(modelEl).toHaveTextContent(def!.name);
    expect(modelEl).toHaveClass("truncate");
    expect(modelEl).toHaveClass("min-w-0");
  });

  it("falls back to raw modelId when unknown to catalog", () => {
    const session = sessionStub({ modelId: "custom/unknown-model" });

    render(
      <ChatHistoryRow
        session={session}
        isActive={false}
        isAuthenticated={false}
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByText("custom/unknown-model")).toBeInTheDocument();
  });

  it("omits model line when modelId absent", () => {
    const session = sessionStub();

    render(
      <ChatHistoryRow
        session={session}
        isActive={false}
        isAuthenticated={false}
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.queryByTestId("chat-history-model")).not.toBeInTheDocument();
  });

  it("renders workspace thread owner avatar when provided", () => {
    render(
      <ChatHistoryRow
        session={sessionStub()}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        workspaceThreadOwner={{
          status: "show",
          displayName: "Jamie Doe",
          imageUrl: "https://example.com/avatar.png",
        }}
        actions={actions}
      />,
    );

    const wrap = screen.getByTestId("chat-history-owner-avatar");
    expect(wrap).toBeInTheDocument();
    // Radix Avatar keeps initials in fallback until the image has loaded in the browser.
    expect(wrap.textContent).toContain("JD");
  });

  it("does not render hover pin overlay when shared thread is unpinned", () => {
    render(
      <ChatHistoryRow
        session={sessionStub({ isPinned: false })}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        workspaceThreadOwner={{ status: "generic" }}
        actions={actions}
      />,
    );

    expect(screen.queryByLabelText("Pinned")).not.toBeInTheDocument();
  });

  it("renders hover pin target in the DOM when shared thread is pinned", () => {
    render(
      <ChatHistoryRow
        session={sessionStub({ isPinned: true })}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        workspaceThreadOwner={{ status: "generic" }}
        actions={actions}
      />,
    );

    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("renders generic workspace thread owner placeholder", () => {
    render(
      <ChatHistoryRow
        session={sessionStub()}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        workspaceThreadOwner={{ status: "generic" }}
        actions={actions}
      />,
    );

    const wrap = screen.getByTestId("chat-history-owner-avatar");
    expect(wrap.querySelector("svg")).toBeTruthy();
  });

  it("does not render owner avatar when workspaceThreadOwner omitted", () => {
    render(
      <ChatHistoryRow
        session={sessionStub()}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(
      screen.queryByTestId("chat-history-owner-avatar"),
    ).not.toBeInTheDocument();
  });

  it("selects thread on row click when not streaming", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const session = sessionStub({ _id: "row-1" });

    render(
      <ChatHistoryRow
        session={session}
        isActive={false}
        isAuthenticated={false}
        isStreaming={false}
        onSelect={onSelect}
        actions={actions}
      />,
    );

    await user.click(screen.getByText("hello world"));
    expect(onSelect).toHaveBeenCalledWith(session);
  });

  it("shows Archive in the row menu for an active session", () => {
    render(
      <ChatHistoryRow
        session={sessionStub({ status: "active" })}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("shows promote to test case control and calls onConvert when clicked", async () => {
    const onConvertToTestCase = vi.fn();
    const user = userEvent.setup();
    const session = sessionStub({ status: "active" });
    render(
      <ChatHistoryRow
        session={session}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        canConvertToTestCase
        onConvertToTestCase={onConvertToTestCase}
        actions={actions}
      />,
    );

    const promote = screen.getByTestId("chat-history-promote-to-test-case");
    expect(promote).toHaveAttribute("aria-label", "Promote to test case");
    expect(
      screen.queryByText("Promote to test case", { exact: true }),
    ).not.toBeInTheDocument();

    await user.click(promote);
    expect(onConvertToTestCase).toHaveBeenCalledTimes(1);
    expect(onConvertToTestCase).toHaveBeenCalledWith(session);
  });

  it("shows Unarchive when the session is archived", () => {
    render(
      <ChatHistoryRow
        session={sessionStub({ status: "archived" })}
        isActive={false}
        isAuthenticated
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByText("Unarchive")).toBeInTheDocument();
  });

  it("shows a pinned indicator when isPinned", () => {
    render(
      <ChatHistoryRow
        session={sessionStub({ isPinned: true })}
        isActive={false}
        isAuthenticated={false}
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("keeps long custom titles truncatable within a narrow rail", () => {
    const longTitle =
      "suuuuuuuuuuper long prompt suuuuuuuuuupersuuuuuuuuuupersuuuu";
    render(
      <div style={{ width: 120 }}>
        <ChatHistoryRow
          session={sessionStub({ customTitle: longTitle })}
          isActive={false}
          isAuthenticated={false}
          isStreaming={false}
          onSelect={vi.fn()}
          actions={actions}
        />
      </div>,
    );

    const title = screen.getByText(longTitle);
    expect(title).toHaveClass("truncate");
    expect(title).toHaveAttribute("title", longTitle);
    const row = title.closest(".group");
    expect(row?.className).toContain("overflow-hidden");
    expect(title.closest(".max-w-full")?.className).toContain("w-full");
  });

  it("does not surface read/unread in the row menu", () => {
    render(
      <ChatHistoryRow
        session={sessionStub({ isUnread: true })}
        isActive={false}
        isAuthenticated={false}
        isStreaming={false}
        onSelect={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.queryByText("Mark read")).not.toBeInTheDocument();
    expect(screen.queryByText("Mark unread")).not.toBeInTheDocument();
  });
});
