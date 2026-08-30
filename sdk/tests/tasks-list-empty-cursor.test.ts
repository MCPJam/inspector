import { describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client.js";

/**
 * `tasks/list` pagination — the empty-string cursor.
 *
 * MCP 2026-07-28 (and `draft`) `server/utilities/pagination` says a client
 * "MUST NOT" decide anything from a cursor's value beyond whether a non-null
 * one was provided, and that "an empty string is a valid cursor and thus MUST
 * NOT be treated as the end of results".
 *
 * `tasks/list` belongs to the separately-versioned 2025-11-25 in-core tasks
 * utility (SEP-2663 removed it from the newer wire), so it was left out of the
 * `tools/prompts/resources/templates/skills` fix in #4462. It carried the same
 * defect: `params: cursor ? { cursor } : {}` dropped a `""` handed back by the
 * previous page, which restarts a caller's walk at page one instead of
 * advancing it.
 *
 * There is no page walk over `tasks/list` in this repo — every caller reads a
 * single page — so these tests drive the walk the way a caller would, and
 * assert on the exact request params that reach the wire.
 */

const LEGACY_TASK_CAPS = {
  tools: {},
  tasks: { list: true, cancel: true, requests: { tools: { call: true } } },
} as const;

interface Recorded {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * A manager whose one live client answers `tasks/list` from a queue of pages
 * and records every request verbatim.
 */
function seedManager(pages: unknown[]): {
  manager: MCPClientManager;
  calls: Recorded[];
  serverId: string;
} {
  const serverId = "srv";
  const calls: Recorded[] = [];
  const manager = new MCPClientManager();
  let index = 0;

  const client = {
    getServerCapabilities: () => LEGACY_TASK_CAPS,
    getNegotiatedProtocolVersion: () => "2025-11-25",
    getProtocolEra: () => undefined,
    getServerVersion: () => ({ name: "fixture", version: "1.0.0" }),
    getInstructions: () => undefined,
    requestWithSchema: async (req: Recorded) => {
      calls.push(JSON.parse(JSON.stringify(req)));
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page;
    },
  } as unknown as ManagedMcpClient;

  (manager as any).registeredServers.set(serverId, {
    config: { url: "https://example.test/mcp" },
    timeout: 1000,
  });
  (manager as any).liveClientStates.set(serverId, { client });

  return { manager, calls, serverId };
}

/** The walk a caller writes: absence ends it, `""` does not. */
async function walkTasks(
  manager: MCPClientManager,
  serverId: string,
  maxPages: number
): Promise<{ taskIds: string[]; complete: boolean }> {
  const taskIds: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result: any = await manager.listTasks(serverId, cursor);
    for (const task of result.tasks ?? []) taskIds.push(task.taskId);

    const nextCursor =
      typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    // ABSENCE ends the walk, not emptiness.
    if (nextCursor === undefined) return { taskIds, complete: true };
    cursor = nextCursor;
  }

  // Stopped at the cap: the listing was NOT read to the end.
  return { taskIds, complete: false };
}

describe("tasks/list cursor forwarding", () => {
  it("sends no cursor at all when the caller supplies none", async () => {
    const { manager, calls, serverId } = seedManager([{ tasks: [] }]);

    await manager.listTasks(serverId);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("tasks/list");
    expect(calls[0].params).toEqual({});
  });

  it("forwards an empty-string cursor verbatim instead of dropping it", async () => {
    const { manager, calls, serverId } = seedManager([{ tasks: [] }]);

    await manager.listTasks(serverId, "");

    expect(calls[0].params).toEqual({ cursor: "" });
  });

  it("continues the walk past a page whose nextCursor is the empty string, and re-sends it", async () => {
    const { manager, calls, serverId } = seedManager([
      { tasks: [{ taskId: "t1" }], nextCursor: "" },
      { tasks: [{ taskId: "t2" }] },
    ]);

    const walk = await walkTasks(manager, serverId, 8);

    // The second page was reached, so `""` was not read as the end of results.
    expect(walk.taskIds).toEqual(["t1", "t2"]);
    expect(walk.complete).toBe(true);
    // ...and the follow-up request actually carried it on the wire.
    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual({});
    expect(calls[1].params).toEqual({ cursor: "" });
  });

  it("ends the walk when nextCursor is absent, null, or not a string", async () => {
    for (const page of [
      { tasks: [{ taskId: "t1" }] },
      { tasks: [{ taskId: "t1" }], nextCursor: null },
      { tasks: [{ taskId: "t1" }], nextCursor: 42 },
    ]) {
      const { manager, calls, serverId } = seedManager([page]);

      const walk = await walkTasks(manager, serverId, 8);

      expect(walk.taskIds).toEqual(["t1"]);
      expect(walk.complete).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });

  it("walks a server that repeats one constant cursor rather than truncating at it", async () => {
    // A server holding its pagination state server-side may legally hand back
    // one constant opaque handle. Comparing two cursors for equality would be
    // a determination based on cursor value — and `""` would join any seen-set
    // and break the very case above — so there is no repeated-cursor guard.
    // The page cap bounds our own work instead, and a cap stop reports the
    // listing as INCOMPLETE rather than as a finished read.
    const { manager, calls, serverId } = seedManager([
      { tasks: [{ taskId: "t1" }], nextCursor: "" },
      { tasks: [{ taskId: "t2" }], nextCursor: "" },
      { tasks: [{ taskId: "t3" }], nextCursor: "" },
      { tasks: [{ taskId: "t4" }] },
    ]);

    const walk = await walkTasks(manager, serverId, 8);

    expect(walk.taskIds).toEqual(["t1", "t2", "t3", "t4"]);
    expect(walk.complete).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.params)).toEqual([
      {},
      { cursor: "" },
      { cursor: "" },
      { cursor: "" },
    ]);
  });

  it("stops a never-ending constant cursor at the page cap, reported as incomplete", async () => {
    const { manager, calls, serverId } = seedManager([
      { tasks: [{ taskId: "t1" }], nextCursor: "same" },
    ]);

    const walk = await walkTasks(manager, serverId, 3);

    expect(walk.complete).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.params)).toEqual([
      {},
      { cursor: "same" },
      { cursor: "same" },
    ]);
  });
});
