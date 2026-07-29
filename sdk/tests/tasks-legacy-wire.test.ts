import { describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager";
import { resolveTasksWire } from "../src/mcp-client-manager/tasks-dispatch.js";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client.js";

/**
 * PR1 blast-radius guard for the legacy (2025-11-25 in-core) tasks wire.
 *
 * Two properties are asserted on exact request bytes:
 *   1. a task-augmented `tools/call` carries `params.task` (the 2025-11-25
 *      form) — beta.4 dropped the `RequestOptions.task` field, which is how
 *      the create path silently degraded to a plain call;
 *   2. every NON-task call is byte-identical to the pre-change wire, because
 *      `executeTool` is shared by every protocol version.
 */

const LEGACY_TASK_CAPS = {
  tools: {},
  tasks: { list: true, cancel: true, requests: { tools: { call: true } } },
} as const;

interface Recorded {
  method: string;
  params?: Record<string, unknown>;
}

function seedManager(options: {
  serverId?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  requestResult?: unknown;
  callToolResult?: unknown;
}): { manager: MCPClientManager; calls: Recorded[]; serverId: string } {
  const serverId = options.serverId ?? "srv";
  const calls: Recorded[] = [];
  const manager = new MCPClientManager();

  const client = {
    getServerCapabilities: () => options.capabilities,
    getNegotiatedProtocolVersion: () => options.protocolVersion,
    getProtocolEra: () => undefined,
    getServerVersion: () => ({ name: "fixture", version: "1.0.0" }),
    getInstructions: () => undefined,
    request: async (req: Recorded) => {
      calls.push(JSON.parse(JSON.stringify(req)));
      return options.requestResult;
    },
    requestWithSchema: async (req: Recorded) => {
      calls.push(JSON.parse(JSON.stringify(req)));
      return options.requestResult;
    },
    callTool: async (params: Record<string, unknown>) => {
      calls.push(
        JSON.parse(JSON.stringify({ method: "tools/call", params }))
      );
      return options.callToolResult ?? { content: [] };
    },
  } as unknown as ManagedMcpClient;

  (manager as any).registeredServers.set(serverId, {
    config: { url: "https://example.test/mcp" },
    timeout: 1000,
  });
  (manager as any).liveClientStates.set(serverId, { client });

  return { manager, calls, serverId };
}

describe("resolveTasksWire", () => {
  it("routes pre-2025-11-25 versions to none even with legacy caps", () => {
    for (const version of ["2025-03-26", "2025-06-18"]) {
      expect(resolveTasksWire(version, LEGACY_TASK_CAPS as never)).toBe("none");
    }
  });

  it("routes 2025-11-25 with legacy caps to the legacy wire", () => {
    expect(resolveTasksWire("2025-11-25", LEGACY_TASK_CAPS as never)).toBe(
      "legacy"
    );
  });

  it("treats the extension capability as absent on 2025-11-25", () => {
    expect(
      resolveTasksWire("2025-11-25", {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      } as never)
    ).toBe("none");
  });

  it("routes 2025-11-25 without task caps to none", () => {
    expect(resolveTasksWire("2025-11-25", { tools: {} } as never)).toBe("none");
  });

  it("routes 2026-07-28 with the extension declared to the extension wire", () => {
    expect(
      resolveTasksWire("2026-07-28", {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      } as never)
    ).toBe("extension");
  });

  it("ignores in-core task caps on 2026-07-28", () => {
    expect(resolveTasksWire("2026-07-28", LEGACY_TASK_CAPS as never)).toBe(
      "none"
    );
  });

  it("fails closed on unknown or missing versions", () => {
    expect(resolveTasksWire(undefined, LEGACY_TASK_CAPS as never)).toBe("none");
    expect(resolveTasksWire("DRAFT-2027-zzz", LEGACY_TASK_CAPS as never)).toBe(
      "none"
    );
  });
});

describe("executeTool legacy task wire", () => {
  it("sends the task opt-in in params (not options) on 2025-11-25", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_TASK_CAPS as never,
      requestResult: { task: { taskId: "t-1", status: "working" } },
    });

    const result = (await manager.executeTool(
      serverId,
      "long_tool",
      { a: 1 },
      undefined,
      { ttl: 60000 }
    )) as { task: { taskId: string } };

    expect(result.task.taskId).toBe("t-1");
    expect(calls).toEqual([
      {
        method: "tools/call",
        params: { name: "long_tool", arguments: { a: 1 }, task: { ttl: 60000 } },
      },
    ]);
  });

  it("sends an empty task object when no ttl is supplied", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_TASK_CAPS as never,
      requestResult: { task: { taskId: "t-2", status: "working" } },
    });

    await manager.executeTool(serverId, "long_tool", {}, undefined, {});
    expect(calls[0].params).toEqual({
      name: "long_tool",
      arguments: {},
      task: {},
    });
  });

  it("throws (and sends nothing) when the wire is not legacy", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2025-06-18",
      capabilities: LEGACY_TASK_CAPS as never,
    });

    await expect(
      manager.executeTool(serverId, "long_tool", {}, undefined, { ttl: 1000 })
    ).rejects.toThrow(/does not speak the 2025-11-25 tasks wire/);
    expect(calls).toEqual([]);
  });

  it("leaves non-task calls byte-identical on every version", async () => {
    for (const version of [
      "2025-03-26",
      "2025-06-18",
      "2025-11-25",
      "2026-07-28",
    ]) {
      const { manager, calls, serverId } = seedManager({
        protocolVersion: version,
        capabilities: LEGACY_TASK_CAPS as never,
        callToolResult: { content: [{ type: "text", text: "ok" }] },
      });

      await manager.executeTool(serverId, "plain_tool", { a: 1 });
      expect(calls).toEqual([
        { method: "tools/call", params: { name: "plain_tool", arguments: { a: 1 } } },
      ]);
    }
  });
});

describe("legacy tasks capability probes", () => {
  it("report false on versions that do not carry the in-core utility", () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2025-06-18",
      capabilities: LEGACY_TASK_CAPS as never,
    });
    expect(manager.supportsTasksForToolCalls(serverId)).toBe(false);
    expect(manager.supportsTasksList(serverId)).toBe(false);
    expect(manager.supportsTasksCancel(serverId)).toBe(false);
    expect(manager.getTasksWire(serverId)).toBe("none");
  });

  it("report true on 2025-11-25 with the in-core caps", () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_TASK_CAPS as never,
    });
    expect(manager.supportsTasksForToolCalls(serverId)).toBe(true);
    expect(manager.supportsTasksList(serverId)).toBe(true);
    expect(manager.supportsTasksCancel(serverId)).toBe(true);
    expect(manager.getTasksWire(serverId)).toBe("legacy");
  });

  it("do not trip on an extension-only 2026-07-28 server", () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: {
        tools: {},
        extensions: { "io.modelcontextprotocol/tasks": {} },
      } as never,
    });
    expect(manager.supportsTasksForToolCalls(serverId)).toBe(false);
    expect(manager.getTasksWire(serverId)).toBe("extension");
  });
});

describe("getInitializationInfo protocol version", () => {
  it("reads the public negotiated-version accessor", () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_TASK_CAPS as never,
    });
    expect(manager.getInitializationInfo(serverId)?.protocolVersion).toBe(
      "2025-11-25"
    );
    expect(manager.getNegotiatedProtocolVersion(serverId)).toBe("2025-11-25");
  });
});
