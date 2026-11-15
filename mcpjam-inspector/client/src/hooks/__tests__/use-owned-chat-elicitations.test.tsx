import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeChatElicitations,
  useOwnedChatElicitations,
} from "../use-owned-chat-elicitations";

const query = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({ useQuery: query }));
const request = {
  rendezvousId: "request",
  serverId: "server",
  chatSessionId: "chat",
  mode: "form" as const,
  message: "Answer",
  expiresAt: 1000,
};
beforeEach(() => query.mockReset());

describe("owned chat elicitation delivery", () => {
  it("queries the exact project and chat and excludes plugin-owned or foreign rows", () => {
    query.mockReturnValue([
      request,
      { ...request, chatSessionId: "other" },
      { ...request, pluginWorkspaceId: "plugin" },
    ]);
    const { result } = renderHook(() =>
      useOwnedChatElicitations({
        enabled: true,
        projectId: "project",
        chatSessionId: "chat",
      }),
    );
    expect(query.mock.calls[0][1]).toEqual({
      projectId: "project",
      chatSessionId: "chat",
    });
    expect(result.current).toEqual([{ ...request, kind: "request" }]);
  });

  it("does not issue an unscoped query", () => {
    renderHook(() =>
      useOwnedChatElicitations({ enabled: true, projectId: "project" }),
    );
    expect(query.mock.calls[0][1]).toBe("skip");
  });

  it("deduplicates stream and query delivery by the owned rendezvous id", () => {
    const event = { ...request, kind: "request" as const };
    expect(mergeChatElicitations([event], [event])).toEqual([event]);
    expect(mergeChatElicitations([], [])).toEqual([]);
  });
});
