import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { ChatHistoryRow } from "../ChatHistoryRow";
import { getModelById } from "@/shared/types";

function sessionStub(overrides: Partial<ChatHistorySession> = {}): ChatHistorySession {
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

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

vi.mock("@/components/ui/input", () => ({
  Input: () => <input data-testid="rename-input" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
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

    expect(screen.getByText(def!.name)).toBeInTheDocument();
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
