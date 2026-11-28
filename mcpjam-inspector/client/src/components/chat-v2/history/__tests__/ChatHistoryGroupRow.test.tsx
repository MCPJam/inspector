import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { ChatHistoryGroupRow } from "../ChatHistoryGroupRow";
import { foldMultiModelSessions } from "../multi-model-session-rows";

vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({ hostedCatalog: [] }),
}));
vi.mock("@mcpjam/design-system/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
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
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

function column(
  id: string,
  position: number,
  overrides: Partial<ChatHistorySession> = {},
): ChatHistorySession {
  return {
    _id: id,
    chatSessionId: `chat-${id}`,
    firstMessagePreview: "Find open bugs",
    status: "active",
    directVisibility: "private",
    messageCount: 2,
    version: 1,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    isPinned: false,
    manualUnread: false,
    isUnread: false,
    modelId: `model-${id}`,
    multiModel: {
      groupId: "g1",
      position,
      columnKind: "model",
      compareId: `cmp-${id}`,
    },
    ...overrides,
  };
}

const rowActions = {
  rename: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  share: vi.fn(),
  unshare: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
};

function renderGroup(
  sessions: ChatHistorySession[],
  extra: { hostName?: (hostId: string) => string | undefined } = {},
) {
  const [entry] = foldMultiModelSessions(sessions);
  if (entry?.kind !== "group") throw new Error("expected a group");
  const groupActions = {
    rename: vi.fn().mockResolvedValue(undefined),
    pin: vi.fn().mockResolvedValue(undefined),
    unpin: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    unarchive: vi.fn().mockResolvedValue(undefined),
  };
  const props = {
    onSelectGroup: vi.fn(),
    onSelectColumn: vi.fn(),
    onActionComplete: vi.fn(),
  };
  render(
    <ChatHistoryGroupRow
      entry={entry}
      activeSessionId={null}
      isAuthenticated
      isStreaming={false}
      actions={rowActions}
      groupActions={groupActions}
      {...props}
      {...extra}
    />,
  );
  return { groupActions, ...props };
}

describe("ChatHistoryGroupRow", () => {
  it("opens the whole session from the group row and one column from its row", async () => {
    const user = userEvent.setup();
    const a = column("a", 0);
    const b = column("b", 1);
    const { onSelectGroup, onSelectColumn } = renderGroup([a, b]);

    expect(screen.getByTestId("chat-history-model")).toHaveTextContent(
      "2 models · model-a, model-b",
    );
    await user.click(screen.getByText("Find open bugs"));
    expect(onSelectGroup).toHaveBeenCalledWith(a);

    await user.click(screen.getByRole("button", { name: "Show columns" }));
    const columns = screen.getByTestId("chat-history-multi-model-columns");
    await user.click(within(columns).getByText("model-b"));
    expect(onSelectColumn).toHaveBeenCalledWith(b);
  });

  it("gives column rows no menu and marks a removed column", async () => {
    const user = userEvent.setup();
    renderGroup([
      column("a", 0),
      column("b", 1),
      column("c", 2, {
        multiModel: {
          groupId: "g1",
          position: 2,
          columnKind: "model",
          compareId: "cmp-c",
          removedAt: 5,
        },
      }),
    ]);
    await user.click(screen.getByRole("button", { name: "Show columns" }));
    const columns = screen.getByTestId("chat-history-multi-model-columns");
    expect(within(columns).queryByTestId("dropdown-menu")).toBeNull();
    expect(within(columns).getByText("Removed")).toBeInTheDocument();
    // The group row has the only menu.
    expect(screen.getAllByTestId("dropdown-menu")).toHaveLength(1);
  });

  it("routes the group menu to the whole session and reports every column", async () => {
    const user = userEvent.setup();
    const a = column("a", 0);
    const b = column("b", 1);
    const { groupActions, onActionComplete } = renderGroup([a, b]);

    expect(screen.queryByText("Add to Shared Sessions")).toBeNull();
    await user.click(screen.getByText("Pin"));
    expect(groupActions.pin).toHaveBeenCalledWith("g1");
    expect(rowActions.pin).not.toHaveBeenCalled();

    await user.click(screen.getByText("Archive multi-model session"));
    expect(groupActions.archive).toHaveBeenCalledWith("g1");
    expect(rowActions.archive).not.toHaveBeenCalled();
    expect(onActionComplete).toHaveBeenCalledWith({
      action: "archive",
      session: a,
    });
    expect(onActionComplete).toHaveBeenCalledWith({
      action: "archive",
      session: b,
    });
  });

  it("names client columns by their client", async () => {
    const user = userEvent.setup();
    const host = (id: string, position: number, hostId: string) =>
      column(id, position, {
        hostId,
        modelId: "gpt-6",
        multiModel: {
          groupId: "g1",
          position,
          columnKind: "host",
          compareId: `pane-${id}`,
        },
      });
    renderGroup([host("a", 0, "h-claude"), host("b", 1, "h-chatgpt")], {
      hostName: (hostId) =>
        ({ "h-claude": "Claude", "h-chatgpt": "ChatGPT" })[hostId],
    });
    expect(screen.getByTestId("chat-history-model")).toHaveTextContent(
      "2 clients · Claude, ChatGPT",
    );
    await user.click(screen.getByRole("button", { name: "Show columns" }));
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
  });
});
