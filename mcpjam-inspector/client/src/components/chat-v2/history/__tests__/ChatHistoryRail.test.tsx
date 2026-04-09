import type { ButtonHTMLAttributes, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { ChatHistoryRail } from "../ChatHistoryRail";

const { refetchMock, archiveAllActiveMock, useChatHistoryMock } = vi.hoisted(
  () => {
    const refetchMock = vi.fn();
    const archiveAllActiveMock = vi.fn();
    const useChatHistoryMock = vi.fn(() => ({
      personal: [] as ChatHistorySession[],
      workspace: [] as ChatHistorySession[],
      loading: false,
      error: null,
      refetch: refetchMock,
      actions: {
        rename: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        share: vi.fn(),
        unshare: vi.fn(),
        pin: vi.fn(),
        unpin: vi.fn(),
        markRead: vi.fn(),
        markUnread: vi.fn(),
        archiveAllActive: archiveAllActiveMock,
      },
    }));
    return { refetchMock, archiveAllActiveMock, useChatHistoryMock };
  },
);

vi.mock("../use-chat-history", () => ({
  useChatHistory: useChatHistoryMock,
}));

vi.mock("../ChatHistoryRow", () => ({
  ChatHistoryRow: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

function sessionStub(id: string): ChatHistorySession {
  return {
    _id: id,
    chatSessionId: `chat-${id}`,
    firstMessagePreview: "hi",
    status: "active",
    directVisibility: "private",
    messageCount: 1,
    version: 1,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    isPinned: false,
    manualUnread: false,
    isUnread: false,
  };
}

describe("ChatHistoryRail", () => {
  beforeEach(() => {
    refetchMock.mockReset();
    archiveAllActiveMock.mockReset();
    useChatHistoryMock.mockImplementation(() => ({
      personal: [],
      workspace: [],
      loading: false,
      error: null,
      refetch: refetchMock,
      actions: {
        rename: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        share: vi.fn(),
        unshare: vi.fn(),
        pin: vi.fn(),
        unpin: vi.fn(),
        markRead: vi.fn(),
        markUnread: vi.fn(),
        archiveAllActive: archiveAllActiveMock,
      },
    }));
  });

  it("refetches history when streaming completes, including delayed retries", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ChatHistoryRail
          activeSessionId={null}
          isAuthenticated
          isStreaming={false}
          workspaceId="workspace-1"
          onSelectThread={vi.fn()}
          onNewChat={vi.fn()}
        />,
      );

      expect(refetchMock).not.toHaveBeenCalled();

      rerender(
        <ChatHistoryRail
          activeSessionId={null}
          isAuthenticated
          isStreaming
          workspaceId="workspace-1"
          onSelectThread={vi.fn()}
          onNewChat={vi.fn()}
        />,
      );

      expect(refetchMock).not.toHaveBeenCalled();

      rerender(
        <ChatHistoryRail
          activeSessionId={null}
          isAuthenticated
          isStreaming={false}
          workspaceId="workspace-1"
          onSelectThread={vi.fn()}
          onNewChat={vi.fn()}
        />,
      );

      expect(refetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(refetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(550);
      expect(refetchMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1200);
      expect(refetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("archive all confirms then calls archiveAllActive", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    useChatHistoryMock.mockImplementation(() => ({
      personal: [sessionStub("p1")],
      workspace: [],
      loading: false,
      error: null,
      refetch: refetchMock,
      actions: {
        rename: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        share: vi.fn(),
        unshare: vi.fn(),
        pin: vi.fn(),
        unpin: vi.fn(),
        markRead: vi.fn(),
        markUnread: vi.fn(),
        archiveAllActive: archiveAllActiveMock,
      },
    }));

    archiveAllActiveMock.mockResolvedValue(undefined);

    render(
      <ChatHistoryRail
        activeSessionId={null}
        isAuthenticated
        isStreaming={false}
        workspaceId="workspace-1"
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /archive all threads/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(archiveAllActiveMock).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("archive all does not call API when confirm is dismissed", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    useChatHistoryMock.mockImplementation(() => ({
      personal: [sessionStub("p1")],
      workspace: [],
      loading: false,
      error: null,
      refetch: refetchMock,
      actions: {
        rename: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        share: vi.fn(),
        unshare: vi.fn(),
        pin: vi.fn(),
        unpin: vi.fn(),
        markRead: vi.fn(),
        markUnread: vi.fn(),
        archiveAllActive: archiveAllActiveMock,
      },
    }));

    render(
      <ChatHistoryRail
        activeSessionId={null}
        isAuthenticated
        isStreaming={false}
        workspaceId="workspace-1"
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /archive all threads/i }));
    expect(archiveAllActiveMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
