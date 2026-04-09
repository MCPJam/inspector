import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import * as chatHistoryApi from "@/lib/apis/web/chat-history-api";
import { useChatHistory } from "../use-chat-history";

const {
  useConvexAuthMock,
  useMutationMock,
  useQueryMock,
  reactiveArchiveMutationMock,
} = vi.hoisted(() => {
  const reactiveArchiveMutationMock = vi.fn();
  return {
    useConvexAuthMock: vi.fn(() => ({
      isAuthenticated: false,
      isLoading: false,
    })),
    useQueryMock: vi.fn(() => undefined),
    useMutationMock: vi.fn((name: string) => {
      if (name === "directChatHistory:archiveCurrentSession") {
        return reactiveArchiveMutationMock;
      }
      return vi.fn();
    }),
    reactiveArchiveMutationMock,
  };
});

vi.mock("convex/react", () => ({
  useConvexAuth: () => useConvexAuthMock(),
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (...args: unknown[]) => useMutationMock(...args),
}));

vi.mock("@/lib/apis/web/chat-history-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/web/chat-history-api")>();
  return {
    ...actual,
    listChatHistory: vi.fn(),
    chatHistoryAction: vi.fn(),
  };
});

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

describe("useChatHistory archiveAllActive", () => {
  beforeEach(() => {
    useConvexAuthMock.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    useQueryMock.mockReturnValue(undefined);
    useMutationMock.mockImplementation((name: string) => {
      if (name === "directChatHistory:archiveCurrentSession") {
        return reactiveArchiveMutationMock;
      }
      return vi.fn();
    });
    reactiveArchiveMutationMock.mockReset();
    vi.mocked(chatHistoryApi.listChatHistory).mockResolvedValue({
      ok: true,
      personal: [sessionStub("p1")],
      workspace: [sessionStub("w1")],
    });
    vi.mocked(chatHistoryApi.chatHistoryAction).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("archives all listed sessions then refetches once", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.actions.archiveAllActive();
    });

    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledTimes(2);
    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledWith(
      "archive",
      "p1",
      undefined,
      expect.objectContaining({ headers: undefined }),
    );
    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledWith(
      "archive",
      "w1",
      undefined,
      expect.objectContaining({ headers: undefined }),
    );
    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(2);
  });

  it("no-ops when there are no sessions", async () => {
    vi.mocked(chatHistoryApi.listChatHistory).mockResolvedValue({
      ok: true,
      personal: [],
      workspace: [],
    });

    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const listCallsBefore = vi.mocked(chatHistoryApi.listChatHistory).mock.calls
      .length;

    await act(async () => {
      await result.current.actions.archiveAllActive();
    });

    expect(chatHistoryApi.chatHistoryAction).not.toHaveBeenCalled();
    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(
      listCallsBefore,
    );
  });
});

describe("useChatHistory archiveManySessionIds", () => {
  beforeEach(() => {
    useConvexAuthMock.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    useQueryMock.mockReturnValue(undefined);
    useMutationMock.mockImplementation((name: string) => {
      if (name === "directChatHistory:archiveCurrentSession") {
        return reactiveArchiveMutationMock;
      }
      return vi.fn();
    });
    reactiveArchiveMutationMock.mockReset();
    vi.mocked(chatHistoryApi.listChatHistory).mockResolvedValue({
      ok: true,
      personal: [sessionStub("p1")],
      workspace: [sessionStub("w1")],
    });
    vi.mocked(chatHistoryApi.chatHistoryAction).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("archives only the given ids then refetches once", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.actions.archiveManySessionIds(["p1"]);
    });

    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledTimes(1);
    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledWith(
      "archive",
      "p1",
      undefined,
      expect.objectContaining({ headers: undefined }),
    );
    expect(chatHistoryApi.listChatHistory).toHaveBeenCalledTimes(2);
  });

  it("dedupes duplicate session ids", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.actions.archiveManySessionIds(["p1", "p1"]);
    });

    expect(chatHistoryApi.chatHistoryAction).toHaveBeenCalledTimes(1);
  });

  it("no-ops when id list is empty", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const listCalls = vi.mocked(chatHistoryApi.listChatHistory).mock.calls
      .length;

    await act(async () => {
      await result.current.actions.archiveManySessionIds([]);
    });

    expect(chatHistoryApi.chatHistoryAction).not.toHaveBeenCalled();
    expect(vi.mocked(chatHistoryApi.listChatHistory).mock.calls.length).toBe(
      listCalls,
    );
  });
});

describe("useChatHistory reactive mode", () => {
  beforeEach(() => {
    useConvexAuthMock.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    useQueryMock.mockReturnValue({
      personal: [sessionStub("p1")],
      workspace: [sessionStub("w1")],
    });
    reactiveArchiveMutationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads from Convex instead of the web list endpoint when authenticated", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isReactive).toBe(true);
    expect(result.current.personal.map((session) => session._id)).toEqual([
      "p1",
    ]);
    expect(result.current.workspace.map((session) => session._id)).toEqual([
      "w1",
    ]);
    expect(chatHistoryApi.listChatHistory).not.toHaveBeenCalled();
    expect(useQueryMock).toHaveBeenCalledWith(
      "directChatHistory:listCurrentHistory",
      expect.objectContaining({
        workspaceId: "ws-1",
        status: "active",
      }),
    );
  });

  it("archives session ids through Convex mutations without a manual refetch", async () => {
    const { result } = renderHook(() =>
      useChatHistory({ enabled: true, workspaceId: "ws-1" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.actions.archiveManySessionIds(["p1", "w1"]);
    });

    expect(reactiveArchiveMutationMock).toHaveBeenCalledTimes(2);
    expect(reactiveArchiveMutationMock).toHaveBeenCalledWith({
      sessionId: "p1",
    });
    expect(reactiveArchiveMutationMock).toHaveBeenCalledWith({
      sessionId: "w1",
    });
    expect(chatHistoryApi.chatHistoryAction).not.toHaveBeenCalled();
    expect(chatHistoryApi.listChatHistory).not.toHaveBeenCalled();
  });
});
