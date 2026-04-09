import type { ButtonHTMLAttributes, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { ChatHistoryRail } from "../ChatHistoryRail";

const {
  refetchMock,
  archiveAllActiveMock,
  useChatHistoryMock,
  useWorkspaceMembersMock,
  chatHistoryRowPropsSpy,
} = vi.hoisted(() => {
  const refetchMock = vi.fn();
  const archiveAllActiveMock = vi.fn();
  const chatHistoryRowPropsSpy = vi.fn();
  const useWorkspaceMembersMock = vi.fn(() => ({
    members: [],
    activeMembers: [],
    pendingMembers: [],
    canManageMembers: false,
    isLoading: false,
    hasPendingMembers: false,
  }));
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
    return {
      refetchMock,
      archiveAllActiveMock,
      useChatHistoryMock,
      useWorkspaceMembersMock,
      chatHistoryRowPropsSpy,
    };
  },
);

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceMembers: (...args: unknown[]) =>
    useWorkspaceMembersMock(...args),
}));

vi.mock("../use-chat-history", () => ({
  useChatHistory: useChatHistoryMock,
}));

vi.mock("../ChatHistoryRow", () => ({
  ChatHistoryRow: (props: Record<string, unknown>) => {
    const snapshot = { ...props } as Record<string, unknown>;
    delete snapshot.key;
    chatHistoryRowPropsSpy(snapshot);
    return null;
  },
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

function sessionStub(
  id: string,
  overrides: Partial<ChatHistorySession> = {},
): ChatHistorySession {
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
    ...overrides,
  };
}

describe("ChatHistoryRail", () => {
  beforeEach(() => {
    refetchMock.mockReset();
    archiveAllActiveMock.mockReset();
    chatHistoryRowPropsSpy.mockReset();
    useWorkspaceMembersMock.mockReset();
    useWorkspaceMembersMock.mockReturnValue({
      members: [],
      activeMembers: [],
      pendingMembers: [],
      canManageMembers: false,
      isLoading: false,
      hasPendingMembers: false,
    });
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

  it("passes workspaceThreadOwner into workspace rows from member roster", () => {
    useWorkspaceMembersMock.mockReturnValue({
      members: [],
      activeMembers: [
        {
          _id: "mem-peer",
          workspaceId: "workspace-1",
          userId: "user-peer",
          email: "peer@test.com",
          workspaceRole: "editor",
          canChangeRole: false,
          addedBy: "x",
          addedAt: 0,
          isOwner: false,
          isPending: false,
          hasAccess: true,
          accessSource: "workspace",
          canRemove: false,
          user: {
            name: "Peer User",
            email: "peer@test.com",
            imageUrl: "https://example.com/p.png",
          },
        },
      ],
      pendingMembers: [],
      canManageMembers: false,
      isLoading: false,
      hasPendingMembers: false,
    });

    useChatHistoryMock.mockImplementation(() => ({
      personal: [],
      workspace: [
        sessionStub("ws-row-1", {
          directVisibility: "workspace",
          userId: "user-peer",
        }),
      ],
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

    const workspaceCalls = chatHistoryRowPropsSpy.mock.calls
      .map((c) => c[0] as { session?: ChatHistorySession })
      .filter((p) => p.session?._id === "ws-row-1");
    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0]).toMatchObject({
      workspaceThreadOwner: {
        status: "show",
        displayName: "Peer User",
        imageUrl: "https://example.com/p.png",
      },
    });
  });

  it("omits workspaceThreadOwner for personal history rows", () => {
    useChatHistoryMock.mockImplementation(() => ({
      personal: [sessionStub("p-only")],
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

    const personalCall = chatHistoryRowPropsSpy.mock.calls.find(
      (c) => (c[0] as { session?: ChatHistorySession }).session?._id === "p-only",
    );
    expect(personalCall?.[0]).not.toHaveProperty("workspaceThreadOwner");
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
