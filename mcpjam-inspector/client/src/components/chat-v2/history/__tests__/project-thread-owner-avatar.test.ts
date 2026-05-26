import { describe, expect, it } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ProjectMember } from "@/hooks/useProjects";
import {
  buildProjectOwnerProfileByUserId,
  resolveProjectThreadOwnerAvatar,
} from "../project-thread-owner-avatar";

function session(
  overrides: Partial<ChatHistorySession> = {},
): ChatHistorySession {
  return {
    _id: "doc1",
    chatSessionId: "chat1",
    firstMessagePreview: "hi",
    status: "active",
    directVisibility: "project",
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
): ProjectMember {
  return {
    _id: `m-${userId}`,
    projectId: "ws",
    userId,
    email: user?.email ?? "x@y.com",
    projectRole: "editor",
    canChangeRole: false,
    addedBy: "a",
    addedAt: 0,
    isOwner: false,
    isPending: false,
    hasAccess: true,
    accessSource: "project",
    canRemove: false,
    user,
  };
}

describe("buildProjectOwnerProfileByUserId", () => {
  it("maps userId to profile from active member rows", () => {
    const map = buildProjectOwnerProfileByUserId([
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
    const map = buildProjectOwnerProfileByUserId([
      { ...member("u1", null), user: null },
      {
        ...member("", { name: "x", email: "e", imageUrl: "" }),
        userId: undefined,
      },
    ]);
    expect(map.size).toBe(0);
  });
});

describe("resolveProjectThreadOwnerAvatar", () => {
  it("returns show when the viewer owns the thread (project list always shows owner)", () => {
    const map = buildProjectOwnerProfileByUserId([
      member("me", {
        name: "Me",
        email: "me@b.com",
        imageUrl: "https://me/face.png",
      }),
    ]);
    expect(
      resolveProjectThreadOwnerAvatar(session({ userId: "me" }), map),
    ).toEqual({
      status: "show",
      displayName: "Me",
      imageUrl: "https://me/face.png",
    });
  });

  it("returns show when another project member owns the thread", () => {
    const map = buildProjectOwnerProfileByUserId([
      member("peer", {
        name: "Peer",
        email: "p@b.com",
        imageUrl: "https://i/p.png",
      }),
    ]);
    expect(
      resolveProjectThreadOwnerAvatar(session({ userId: "peer" }), map),
    ).toEqual({
      status: "show",
      displayName: "Peer",
      imageUrl: "https://i/p.png",
    });
  });

  it("returns generic when userId is missing", () => {
    expect(resolveProjectThreadOwnerAvatar(session({}), new Map())).toEqual({
      status: "generic",
    });
  });

  it("returns generic when owner is not in the member map", () => {
    expect(
      resolveProjectThreadOwnerAvatar(
        session({ userId: "stranger" }),
        new Map(),
      ),
    ).toEqual({ status: "generic" });
  });
});
