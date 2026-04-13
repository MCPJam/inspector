import { describe, expect, it } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { WorkspaceMember } from "@/hooks/useWorkspaces";
import {
  buildWorkspaceOwnerProfileByUserId,
  resolveWorkspaceThreadOwnerAvatar,
} from "../workspace-thread-owner-avatar";

function session(
  overrides: Partial<ChatHistorySession> = {},
): ChatHistorySession {
  return {
    _id: "doc1",
    chatSessionId: "chat1",
    firstMessagePreview: "hi",
    status: "active",
    directVisibility: "workspace",
    messageCount: 1,
    version: 1,
    startedAt: 0,
    lastActivityAt: 0,
    isPinned: false,
    manualUnread: false,
    isUnread: false,
    ...overrides,
  };
}

function member(
  userId: string,
  user: { name: string; email: string; imageUrl: string } | null,
): WorkspaceMember {
  return {
    _id: `m-${userId}`,
    workspaceId: "ws",
    userId,
    email: user?.email ?? "x@y.com",
    workspaceRole: "editor",
    canChangeRole: false,
    addedBy: "a",
    addedAt: 0,
    isOwner: false,
    isPending: false,
    hasAccess: true,
    accessSource: "workspace",
    canRemove: false,
    user,
  };
}

describe("buildWorkspaceOwnerProfileByUserId", () => {
  it("maps userId to profile from active member rows", () => {
    const map = buildWorkspaceOwnerProfileByUserId([
      member("u1", {
        name: "Alex",
        email: "a@b.com",
        imageUrl: "https://img.test/a.png",
      }),
    ]);
    expect(map.get("u1")).toEqual({
      name: "Alex",
      imageUrl: "https://img.test/a.png",
    });
  });

  it("skips members without userId or user payload", () => {
    const map = buildWorkspaceOwnerProfileByUserId([
      { ...member("u1", null), user: null },
      {
        ...member("", { name: "x", email: "e", imageUrl: "" }),
        userId: undefined,
      },
    ]);
    expect(map.size).toBe(0);
  });
});

describe("resolveWorkspaceThreadOwnerAvatar", () => {
  it("returns show when the viewer owns the thread (workspace list always shows owner)", () => {
    const map = buildWorkspaceOwnerProfileByUserId([
      member("me", {
        name: "Me",
        email: "me@b.com",
        imageUrl: "https://me/face.png",
      }),
    ]);
    expect(
      resolveWorkspaceThreadOwnerAvatar(session({ userId: "me" }), map),
    ).toEqual({
      status: "show",
      displayName: "Me",
      imageUrl: "https://me/face.png",
    });
  });

  it("returns show when another workspace member owns the thread", () => {
    const map = buildWorkspaceOwnerProfileByUserId([
      member("peer", {
        name: "Peer",
        email: "p@b.com",
        imageUrl: "https://i/p.png",
      }),
    ]);
    expect(
      resolveWorkspaceThreadOwnerAvatar(session({ userId: "peer" }), map),
    ).toEqual({
      status: "show",
      displayName: "Peer",
      imageUrl: "https://i/p.png",
    });
  });

  it("returns generic when userId is missing", () => {
    expect(resolveWorkspaceThreadOwnerAvatar(session({}), new Map())).toEqual({
      status: "generic",
    });
  });

  it("returns generic when owner is not in the member map", () => {
    expect(
      resolveWorkspaceThreadOwnerAvatar(
        session({ userId: "stranger" }),
        new Map(),
      ),
    ).toEqual({ status: "generic" });
  });
});
