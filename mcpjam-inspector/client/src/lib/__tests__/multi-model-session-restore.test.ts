import { comparisonKey } from "@mcpjam/sdk/browser";
import { describe, expect, it } from "vitest";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import {
  buildMultiModelRestore,
  multiModelSessionColumns,
} from "../multi-model-session-restore";

function column(
  chatSessionId: string,
  position: number,
  overrides: Partial<ChatHistorySession> = {},
): ChatHistorySession {
  return {
    _id: `row-${chatSessionId}`,
    chatSessionId,
    firstMessagePreview: "Find open bugs assigned to me",
    status: "active",
    directVisibility: "private",
    modelSelection: { source: "legacy", modelId: `openai/model-${position}` },
    messageCount: 2,
    version: 1,
    startedAt: 1,
    lastActivityAt: 1,
    isPinned: false,
    manualUnread: false,
    isUnread: false,
    multiModel: {
      groupId: "group-1",
      position,
      columnKind: "model",
      compareId: `model-${position}`,
    },
    ...overrides,
  } as ChatHistorySession;
}

function hostColumn(chatSessionId: string, position: number, hostId: string) {
  return column(chatSessionId, position, {
    hostId,
    multiModel: {
      groupId: "group-1",
      position,
      columnKind: "host",
      compareId: `pane-${position}`,
    },
  });
}

const removed = (base: ChatHistorySession): ChatHistorySession => ({
  ...base,
  multiModel: base.multiModel && { ...base.multiModel, removedAt: 5 },
});

describe("multiModelSessionColumns", () => {
  it("keeps live columns of the group in position order", () => {
    const other = column("d", 0, {
      multiModel: {
        groupId: "group-2",
        position: 0,
        columnKind: "model",
        compareId: "x",
      },
    });
    const columns = multiModelSessionColumns("group-1", [
      column("b", 2),
      removed(column("c", 1)),
      other,
      column("a", 0),
    ]);
    expect(columns.map((c) => c.chatSessionId)).toEqual(["a", "b"]);
  });
});

describe("buildMultiModelRestore", () => {
  it("restores model columns keyed the way a restored lineup keys cards", () => {
    const restore = buildMultiModelRestore({
      groupId: "group-1",
      projectId: "project-1",
      sessions: [column("b", 3), removed(column("c", 5)), column("a", 0)],
      selectedServers: ["linear"],
    });
    const keys = [0, 3].map((n) =>
      comparisonKey({ source: "legacy", modelId: `openai/model-${n}` }),
    );
    expect(restore?.record).toMatchObject({
      id: "group-1",
      multiModelEnabled: true,
      selectedServers: ["linear"],
      columns: [
        { compareId: keys[0], order: 0, chatSessionId: "a", kind: "model" },
        { compareId: keys[1], order: 1, chatSessionId: "b", kind: "model" },
      ],
    });
    expect(restore?.positions).toEqual([
      { columnKey: `model:${keys[0]}`, position: 0 },
      { columnKey: `model:${keys[1]}`, position: 3 },
    ]);
    // A removed column's position is never reused.
    expect(restore?.highestPosition).toBe(5);
  });

  it("restores client columns as panes on their saved clients", () => {
    const restore = buildMultiModelRestore({
      groupId: "group-1",
      projectId: "project-1",
      sessions: [
        hostColumn("a", 0, "host-claude"),
        hostColumn("b", 1, "host-gpt"),
      ],
      selectedServers: [],
    });
    expect(restore?.record).toMatchObject({
      multiModelEnabled: false,
      hostIds: ["host-claude", "host-gpt"],
      modelSelections: null,
      panes: [
        { paneId: "pane-0", target: { kind: "host", hostId: "host-claude" } },
        { paneId: "pane-1", target: { kind: "host", hostId: "host-gpt" } },
      ],
      columns: [
        { compareId: "pane-0", kind: "host", order: 0 },
        { compareId: "pane-1", kind: "host", order: 1 },
      ],
    });
  });

  const noClient = column("b", 1, {
    multiModel: {
      groupId: "group-1",
      position: 1,
      columnKind: "host",
      compareId: "pane-1",
    },
  });
  it.each([
    ["a single column", [column("a", 0)]],
    [
      "a column with no saved model",
      [column("a", 0), column("b", 1, { modelSelection: null })],
    ],
    ["a client column with no saved client", [hostColumn("a", 0, "h"), noClient]],
    ["model and client columns mixed", [column("a", 0), hostColumn("b", 1, "h")]],
  ])("refuses %s", (_label, sessions) => {
    expect(
      buildMultiModelRestore({
        groupId: "group-1",
        projectId: "project-1",
        sessions,
        selectedServers: [],
      }),
    ).toBeNull();
  });
});

describe("buildMultiModelRestore with environment columns", () => {
  it("restores an environment column as an environment pane", () => {
    const env = column("b", 1, {
      environmentId: "env-staging",
      multiModel: {
        groupId: "group-1",
        position: 1,
        columnKind: "host",
        compareId: "pane-1",
      },
    });
    const restore = buildMultiModelRestore({
      groupId: "group-1",
      projectId: "project-1",
      sessions: [hostColumn("a", 0, "host-claude"), env],
      selectedServers: [],
    });
    expect(restore?.record).toMatchObject({
      hostIds: ["host-claude"],
      panes: [
        { paneId: "pane-0", target: { kind: "host", hostId: "host-claude" } },
        {
          paneId: "pane-1",
          target: { kind: "environment", environmentId: "env-staging" },
        },
      ],
    });
  });
});
