import { describe, expect, it } from "vitest";
import type { ServerCapabilities } from "@modelcontextprotocol/client";

import { MCPClientManager } from "../src/mcp-client-manager";
import {
  resolveTasksWire,
  type TasksWire,
} from "../src/mcp-client-manager/tasks-dispatch";
import { TasksWireUnsupportedError } from "../src/mcp-client-manager/errors";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client";

// Capability fixtures ---------------------------------------------------------

/** Legacy (2025-11-25) tasks capability under the top-level `tasks` namespace. */
const LEGACY_TASKS_CAPS = {
  tasks: { requests: { tools: { call: true } }, list: true, cancel: true },
} as unknown as ServerCapabilities;

/** Legacy tasks capability under the `experimental.tasks` namespace. */
const EXPERIMENTAL_TASKS_CAPS = {
  experimental: {
    tasks: { requests: { tools: { call: true } }, list: true, cancel: true },
  },
} as unknown as ServerCapabilities;

/**
 * 2026-07-28 `extensions` capability advertising the tasks extension. This
 * MUST NOT be mistaken for the legacy in-params tasks wire.
 */
const EXTENSION_TASKS_CAPS = {
  extensions: { "io.modelcontextprotocol/tasks": {} },
} as unknown as ServerCapabilities;

const NO_TASKS_CAPS = {
  tools: { listChanged: true },
} as unknown as ServerCapabilities;

// resolveTasksWire ------------------------------------------------------------

describe("resolveTasksWire", () => {
  type Case = {
    version: string | undefined;
    caps: ServerCapabilities | undefined;
    label: string;
    expected: TasksWire;
  };

  const capsFixtures: Array<{ label: string; caps: ServerCapabilities }> = [
    { label: "legacy caps present", caps: LEGACY_TASKS_CAPS },
    { label: "experimental legacy caps present", caps: EXPERIMENTAL_TASKS_CAPS },
    { label: "caps.extensions tasks present", caps: EXTENSION_TASKS_CAPS },
    { label: "neither", caps: NO_TASKS_CAPS },
  ];

  const cases: Case[] = [];

  for (const version of [
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
  ] as const) {
    for (const { label, caps } of capsFixtures) {
      // Only 2025-11-25 with a legacy (non-extension) tasks capability routes
      // to "legacy"; everything else is "none" in this PR.
      const hasLegacy =
        caps === LEGACY_TASKS_CAPS || caps === EXPERIMENTAL_TASKS_CAPS;
      const expected: TasksWire =
        version === "2025-11-25" && hasLegacy ? "legacy" : "none";
      cases.push({ version, caps, label, expected });
    }
  }

  // "both" (legacy + extension caps) on 2025-11-25 -> still "legacy".
  cases.push({
    version: "2025-11-25",
    caps: {
      ...(LEGACY_TASKS_CAPS as object),
      ...(EXTENSION_TASKS_CAPS as object),
    } as unknown as ServerCapabilities,
    label: "both legacy and extension caps present",
    expected: "legacy",
  });
  // "both" on 2026-07-28 -> "none" (extension wire not implemented; legacy
  // capability must not upgrade a modern connection to the legacy wire).
  cases.push({
    version: "2026-07-28",
    caps: {
      ...(LEGACY_TASKS_CAPS as object),
      ...(EXTENSION_TASKS_CAPS as object),
    } as unknown as ServerCapabilities,
    label: "both legacy and extension caps present",
    expected: "none",
  });
  // Fail-closed: unknown / undefined version.
  cases.push({
    version: "DRAFT-2027-zzz",
    caps: LEGACY_TASKS_CAPS,
    label: "unknown version with legacy caps",
    expected: "none",
  });
  cases.push({
    version: undefined,
    caps: LEGACY_TASKS_CAPS,
    label: "undefined version with legacy caps",
    expected: "none",
  });

  it.each(cases)(
    "$version / $label -> $expected",
    ({ version, caps, expected }) => {
      expect(resolveTasksWire(version, caps)).toBe(expected);
    }
  );

  it("returns none when caps are undefined on 2025-11-25", () => {
    expect(resolveTasksWire("2025-11-25", undefined)).toBe("none");
  });
});

// Manager wiring --------------------------------------------------------------

type RequestCall = { req: unknown; options: unknown };

interface FakeClient extends ManagedMcpClient {
  requestCalls: RequestCall[];
  callToolCalls: Array<{ params: unknown; options: unknown }>;
}

function makeFakeClient(opts: {
  negotiatedVersion: string | undefined;
  capabilities: ServerCapabilities | undefined;
}): FakeClient {
  const requestCalls: RequestCall[] = [];
  const callToolCalls: Array<{ params: unknown; options: unknown }> = [];

  const client = {
    requestCalls,
    callToolCalls,
    getNegotiatedProtocolVersion: () => opts.negotiatedVersion,
    getServerCapabilities: () => opts.capabilities,
    getServerVersion: () => undefined,
    getInstructions: () => undefined,
    getProtocolEra: () => undefined,
    async request(req: unknown, options?: unknown) {
      requestCalls.push({ req, options });
      // Shape of a legacy CreateTaskResult.
      return {
        task: { taskId: "task-1", status: "working" },
      };
    },
    async callTool(params: unknown, options?: unknown) {
      callToolCalls.push({ params, options });
      return { content: [] };
    },
  } as unknown as FakeClient;

  return client;
}

/** Inject a live, "connected" fake client so executeTool skips real I/O. */
function injectClient(
  manager: MCPClientManager,
  serverId: string,
  client: ManagedMcpClient
): void {
  const internal = manager as unknown as {
    liveClientStates: Map<string, { client: ManagedMcpClient }>;
  };
  internal.liveClientStates.set(serverId, { client });
}

describe("executeTool task wire (legacy 2025-11-25)", () => {
  it("sends params.task = { ttl } inside params, with no task key in options", async () => {
    const manager = new MCPClientManager();
    const client = makeFakeClient({
      negotiatedVersion: "2025-11-25",
      capabilities: LEGACY_TASKS_CAPS,
    });
    injectClient(manager, "srv", client);

    await manager.executeTool(
      "srv",
      "do_thing",
      { a: 1 },
      undefined,
      { ttl: 60000 }
    );

    expect(client.requestCalls).toHaveLength(1);
    const [{ req, options }] = client.requestCalls;
    const typedReq = req as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(typedReq.method).toBe("tools/call");
    expect(typedReq.params.name).toBe("do_thing");
    expect(typedReq.params.arguments).toEqual({ a: 1 });
    expect(typedReq.params.task).toEqual({ ttl: 60000 });
    // The task field must NOT leak into RequestOptions (the beta.4 break).
    expect(options as Record<string, unknown>).not.toHaveProperty("task");
    // Non-task tools/call path is untouched.
    expect(client.callToolCalls).toHaveLength(0);
  });

  it("sends params.task = {} when ttl is omitted", async () => {
    const manager = new MCPClientManager();
    const client = makeFakeClient({
      negotiatedVersion: "2025-11-25",
      capabilities: LEGACY_TASKS_CAPS,
    });
    injectClient(manager, "srv", client);

    await manager.executeTool("srv", "do_thing", {}, undefined, {});

    expect(client.requestCalls).toHaveLength(1);
    const typedReq = client.requestCalls[0].req as {
      params: Record<string, unknown>;
    };
    expect(typedReq.params.task).toEqual({});
  });

  it("non-task tools/call sends params without any task key", async () => {
    const manager = new MCPClientManager();
    const client = makeFakeClient({
      negotiatedVersion: "2025-11-25",
      capabilities: LEGACY_TASKS_CAPS,
    });
    injectClient(manager, "srv", client);

    await manager.executeTool("srv", "do_thing", { a: 1 });

    expect(client.requestCalls).toHaveLength(0);
    expect(client.callToolCalls).toHaveLength(1);
    const { params } = client.callToolCalls[0];
    expect(params as Record<string, unknown>).not.toHaveProperty("task");
    expect(params).toEqual({ name: "do_thing", arguments: { a: 1 } });
  });
});

describe("executeTool task wire gate (non-legacy connections)", () => {
  for (const version of ["2025-06-18", "2026-07-28"] as const) {
    it(`throws TasksWireUnsupportedError and performs no request on ${version}`, async () => {
      const manager = new MCPClientManager();
      const client = makeFakeClient({
        negotiatedVersion: version,
        // Even when the server advertises tasks-like capabilities.
        capabilities: LEGACY_TASKS_CAPS,
      });
      injectClient(manager, "srv", client);

      await expect(
        manager.executeTool("srv", "do_thing", {}, undefined, { ttl: 1000 })
      ).rejects.toBeInstanceOf(TasksWireUnsupportedError);

      expect(client.requestCalls).toHaveLength(0);
      expect(client.callToolCalls).toHaveLength(0);
    });
  }
});

describe("supportsTasks* version gate", () => {
  it("returns false on a 2025-06-18 connection even when tasks are advertised", () => {
    const manager = new MCPClientManager();
    const client = makeFakeClient({
      negotiatedVersion: "2025-06-18",
      capabilities: LEGACY_TASKS_CAPS,
    });
    injectClient(manager, "srv", client);

    expect(manager.supportsTasksForToolCalls("srv")).toBe(false);
    expect(manager.supportsTasksList("srv")).toBe(false);
    expect(manager.supportsTasksCancel("srv")).toBe(false);
  });

  it("returns true on a 2025-11-25 connection advertising legacy tasks", () => {
    const manager = new MCPClientManager();
    const client = makeFakeClient({
      negotiatedVersion: "2025-11-25",
      capabilities: LEGACY_TASKS_CAPS,
    });
    injectClient(manager, "srv", client);

    expect(manager.supportsTasksForToolCalls("srv")).toBe(true);
    expect(manager.supportsTasksList("srv")).toBe(true);
    expect(manager.supportsTasksCancel("srv")).toBe(true);
  });
});
