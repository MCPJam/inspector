import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";

const api = vi.hoisted(() => ({ group: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getMultiModelSessionGroup: api.group,
}));
vi.mock("@/components/chat-v2/history/chat-history-prefetch", () => ({
  getCachedChatHistoryDetail: api.detail,
}));

import { fetchMultiModelRestore } from "../multi-model-session-restore";

const column = (chatSessionId: string, position: number) =>
  ({
    _id: `row-${chatSessionId}`,
    chatSessionId,
    modelSelection: { source: "legacy", modelId: `openai/model-${position}` },
    messageCount: 2,
    multiModel: {
      groupId: "group-1",
      position,
      columnKind: "model",
      compareId: `model-${position}`,
    },
  }) as ChatHistorySession;

const sessions = [column("a", 0), column("b", 1)];
const restoreWith = () =>
  fetchMultiModelRestore({
    groupId: "group-1",
    projectId: "p1",
    selectedServers: ["live"],
    loadedSessions: sessions,
    toServerIds,
  });

// The project's catalog: saved values can be names or ids.
const catalog = new Map([
  ["linear", "srv-linear"],
  ["github", "srv-github"],
]);
const toServerIds = (saved: readonly string[]) =>
  saved.flatMap((value) => {
    if ([...catalog.values()].includes(value)) return [value];
    const id = catalog.get(value);
    return id ? [id] : [];
  });

const pane = (chatSessionId: string, position: number) =>
  ({
    _id: `row-${chatSessionId}`,
    chatSessionId,
    hostId: `host-${position}`,
    messageCount: 2,
    multiModel: {
      groupId: "group-1",
      position,
      columnKind: "host",
      compareId: `pane-${position}`,
    },
  }) as ChatHistorySession;

describe("fetchMultiModelRestore", () => {
  beforeEach(() => {
    api.group.mockResolvedValue({ ok: true, groupId: "group-1", sessions });
    api.detail.mockReset();
  });

  it("brings back the servers the session was saved with", async () => {
    api.detail.mockResolvedValue({
      session: { resumeConfig: { selectedServers: ["linear", "github"] } },
    });
    const restored = await restoreWith();
    expect(restored?.record.selectedServers).toEqual(["linear", "github"]);
    expect(api.detail).toHaveBeenCalledWith({
      sessionId: "row-a",
      chatSessionId: "a",
      projectId: "p1",
    });
  });

  it("keeps the current servers when the session saved none", async () => {
    api.detail.mockResolvedValue({ session: {} });
    expect((await restoreWith())?.record.selectedServers).toEqual(["live"]);
  });

  it("keeps the current servers when the saved ones cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    api.detail.mockRejectedValue(new Error("offline"));
    expect((await restoreWith())?.record.selectedServers).toEqual(["live"]);
  });

  it("gives each client pane its own saved servers as project ids", async () => {
    const panes = [pane("a", 0), pane("b", 1), pane("c", 2)];
    api.group.mockResolvedValue({
      ok: true,
      groupId: "group-1",
      sessions: panes,
    });
    const saved: Record<string, string[] | undefined> = {
      a: ["linear", "github"],
      b: ["srv-github", "gone"],
      c: [],
    };
    api.detail.mockImplementation(async ({ chatSessionId }) => ({
      session: { resumeConfig: { selectedServers: saved[chatSessionId] } },
    }));
    const restored = await fetchMultiModelRestore({
      groupId: "group-1",
      projectId: "p1",
      selectedServers: ["live"],
      loadedSessions: panes,
      toServerIds,
    });
    const record = restored?.record;
    expect(record?.version).toBe(2);
    if (record?.version !== 2) return;
    expect(record.panes.map((p) => p.serverIds)).toEqual([
      ["srv-linear", "srv-github"],
      ["srv-github"],
      [],
    ]);
  });

  it("leaves a pane's servers alone when its detail cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panes = [pane("a", 0), pane("b", 1)];
    api.group.mockResolvedValue({
      ok: true,
      groupId: "group-1",
      sessions: panes,
    });
    api.detail.mockImplementation(async ({ chatSessionId }) => {
      if (chatSessionId === "b") throw new Error("offline");
      return { session: { resumeConfig: { selectedServers: ["linear"] } } };
    });
    const restored = await fetchMultiModelRestore({
      groupId: "group-1",
      projectId: "p1",
      selectedServers: ["live"],
      loadedSessions: panes,
      toServerIds,
    });
    const record = restored?.record;
    if (record?.version !== 2) throw new Error("expected a v2 record");
    expect(record.panes.map((p) => p.serverIds)).toEqual([
      ["srv-linear"],
      undefined,
    ]);
  });
});
