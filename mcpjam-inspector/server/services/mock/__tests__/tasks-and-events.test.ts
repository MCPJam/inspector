/**
 * A mock's tasks, change streams and task-augmented forwards, through the
 * route: tasks live in the backend (stubbed here) so a task created on one
 * replica is polled on another; a 2026-07-28 stream hears the real server's
 * changes; a 2025-11-25 task call is forwarded or refused by what the real
 * server declares.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  tasks: new Map<string, string>(),
  calls: [] as string[],
}));

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));
// The backend's `mockTasks:*`, as B7 describes it: JSON text records scoped by mock and owner.
vi.mock("../../../routes/v1/convex-client.js", () => ({
  createConvexClient: () => ({
    query: async (ref: { name?: string }, args: Record<string, string>) => {
      const name = String((ref as unknown as Record<symbol, string>)[Symbol.for("functionName")] ?? ref.name);
      backend.calls.push(name);
      const key = `${args.mockId}|${args.owner}|${args.taskId}`;
      if (name.endsWith(":get")) return backend.tasks.has(key) ? { recordJson: backend.tasks.get(key) } : null;
      const own = [...backend.tasks.entries()]
        .filter(([k]) => k.startsWith(`${args.mockId}|${args.owner}|`))
        .map(([, json]) => JSON.parse(json));
      return { recordsJson: JSON.stringify(own) };
    },
    mutation: async (ref: { name?: string }, args: Record<string, string>) => {
      const name = String((ref as unknown as Record<symbol, string>)[Symbol.for("functionName")] ?? ref.name);
      backend.calls.push(name);
      if (name.endsWith(":create")) {
        const record = JSON.parse(args.recordJson);
        backend.tasks.set(`${args.mockId}|${record.owner}|${record.taskId}`, args.recordJson);
        return { created: true };
      }
      const key = `${args.mockId}|${args.owner}|${args.taskId}`;
      const stored = backend.tasks.get(key);
      if (!stored) return null;
      const record = JSON.parse(stored);
      if (["completed", "failed", "cancelled"].includes(record.status)) return { recordJson: stored };
      const next = JSON.stringify({ ...record, ...JSON.parse(args.patchJson) });
      backend.tasks.set(key, next);
      return { recordJson: next };
    },
  }),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import {
  startTicketHttp,
  type RunningTicketServer,
} from "../../../routes/mcp/__tests__/helpers/ticket-server.js";
import { backendTaskStore } from "../task-store.js";
import type { OpenReal } from "../connection.js";
import { serveMock, type MockDoor } from "../route.js";
import { resolvedMock } from "./helpers.js";

let ticket: RunningTicketServer & { url: string };
let manager: MCPClientManager | undefined;

const door: MockDoor = {
  kind: "http",
  bearerToken: "ann",
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  profile: { timeoutMs: 5_000 },
};

const open: OpenReal = async () => {
  manager = new MCPClientManager({}, { lazyConnect: true });
  return { manager, config: { url: ticket.url } };
};

beforeEach(async () => {
  ticket = await startTicketHttp();
  backend.tasks.clear();
  backend.calls.length = 0;
});
afterEach(async () => {
  await ticket.close();
});

const definition: MockDefinition = {
  tools: {
    lookup_ticket: {
      answer: { from: "saved", cases: [{ when: { id: "123" }, result: { content: [{ type: "text", text: "saved" }] } }] },
    },
    slow_job: {
      description: "A job that runs as a task.",
      inputSchema: { type: "object", properties: {} },
      answer: {
        from: "saved",
        cases: [{ task: true, result: { content: [{ type: "text", text: "job done" }] } }],
      },
    },
  },
};

function replica(def: MockDefinition = definition, backed = true) {
  return (request: Request) =>
    serveMock(request, "mock1", door, {
      resolve: async () => resolvedMock({ definition: def, baseServerId: backed ? "real1" : null }),
      open,
      check: async () => ({ allowed: true }),
    });
}

async function rpc(serve: (r: Request) => Promise<Response>, revision: string, method: string, params: object, id = 1) {
  const response = await serve(
    new Request("http://mock.local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": revision,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  return payload.find((m) => m.id === id) as { result?: any; error?: any };
}

describe("tasks across replicas", () => {
  it("polls on one replica a task another replica created, through the backend", async () => {
    const created = await rpc(replica(), "2025-11-25", "tools/call", {
      name: "slow_job",
      arguments: {},
      task: { ttl: 60_000 },
    });
    const taskId = created.result.task.taskId as string;
    expect(backend.calls.some((name) => name.endsWith(":create"))).toBe(true);

    const other = replica();
    const polled = await rpc(other, "2025-11-25", "tasks/get", { taskId }, 2);
    expect(polled.result.taskId).toBe(taskId);
    const result = await rpc(other, "2025-11-25", "tasks/result", { taskId }, 3);
    expect(JSON.stringify(result.result)).toContain("job done");
  });

  it("keeps a task from another owner out of reach", async () => {
    const mine = backendTaskStore(async () => "token", "mock1");
    const theirs = backendTaskStore(async () => "token", "mock1");
    await mine.create({
      taskId: "t1",
      owner: "ann",
      status: "working",
      createdAt: 1,
      lastUpdatedAt: 1,
      ttlMs: 1000,
    });
    expect((await theirs.get("ann", "t1"))?.status).toBe("working");
    expect(await theirs.get("bob", "t1")).toBeUndefined();
    expect(await theirs.list("bob")).toEqual([]);
    const updated = await theirs.update("ann", "t1", { status: "completed", lastUpdatedAt: 2 });
    expect(updated?.status).toBe("completed");
    expect((await mine.get("ann", "t1"))?.status).toBe("completed");
    // A finished task is returned as stored.
    expect((await mine.update("ann", "t1", { status: "working", lastUpdatedAt: 3 }))?.status).toBe("completed");
  });
});

describe("a task-augmented tools/call to the real server", () => {
  const asTask = (serve: (r: Request) => Promise<Response>) =>
    rpc(serve, "2025-11-25", "tools/call", { name: "echo", arguments: { message: "hi" }, task: { ttl: 1000 } });

  it("is refused, naming why, when the real server does not run tool calls as tasks", async () => {
    const answered = await asTask(replica());
    const text = JSON.stringify(answered.result);
    expect(answered.result.isError).toBe(true);
    expect(text).toContain("does not run tool calls as tasks");
    expect(text).toContain("without a task");
    expect(ticket.store.dispatches).toEqual([]);
  });

  it("is forwarded when the real server declares tasks for tool calls", async () => {
    const orig = MCPClientManager.prototype.getInitializationInfo;
    const spy = vi
      .spyOn(MCPClientManager.prototype, "getInitializationInfo")
      .mockImplementation(function (this: MCPClientManager, id: string) {
        const info = orig.call(this, id);
        return info && { ...info, serverCapabilities: { ...info.serverCapabilities, tasks: { requests: { tools: { call: {} } } } } };
      });
    try {
      const answered = await asTask(replica());
      expect(JSON.stringify(answered.result)).toContain("echo");
      expect(answered.result.isError).not.toBe(true);
      expect(ticket.store.dispatches.map((d) => d.tool)).toEqual(["echo"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not treat an ordinary call as a task call", async () => {
    const answered = await rpc(replica(), "2025-11-25", "tools/call", { name: "echo", arguments: { message: "hi" } });
    expect(answered.result.isError).not.toBe(true);
    expect(ticket.store.dispatches).toHaveLength(1);
  });
});

describe("the real server's changes on a 2026-07-28 stream", () => {
  async function openStream(serve: (r: Request) => Promise<Response>, notifications: object) {
    const response = await serve(
      new Request("http://mock.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "subscriptions/listen",
          params: {
            notifications,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
            },
          },
        }),
      }),
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: Array<{ method?: string; params?: any }> = [];
    let buffered = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data:"));
          if (data) seen.push(JSON.parse(data.slice(5)));
        }
      }
    })();
    return {
      seen,
      waitFor: async (method: string) => {
        for (let i = 0; i < 200; i++) {
          const hit = seen.find((m) => m.method === method);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`no ${method}; saw ${seen.map((m) => m.method).join(", ")}`);
      },
      close: async () => {
        await reader.cancel().catch(() => undefined);
        await pump;
      },
    };
  }

  it("feeds a list change and a resource update from the real server to the stream, and stops with it", async () => {
    const handlers = new Map<string, (n: unknown) => void>();
    const listen = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
    const stream = await (async () => {
      const serve = (request: Request) =>
        serveMock(request, "mock1", door, {
          resolve: async () =>
            resolvedMock({
              // The mock declares resource subscriptions, so the stream may ask for them.
              definition: { ...definition, capabilities: { resources: { subscribe: true } } },
              baseServerId: "real1",
            }),
          open: async (input) => {
            const opened = await open(input);
            const add = opened.manager.addNotificationHandler.bind(opened.manager);
            vi.spyOn(opened.manager, "addNotificationHandler").mockImplementation((id, method, handler) => {
              handlers.set(String(method), handler as never);
              return add(id, method, handler);
            });
            vi.spyOn(opened.manager, "getManagedClient").mockReturnValue({ listen } as never);
            return opened;
          },
          check: async () => ({ allowed: true }),
        });
      return openStream(serve, { toolsListChanged: true, resourceSubscriptions: ["doc://a"] });
    })();
    await stream.waitFor("notifications/subscriptions/acknowledged");
    expect(listen).toHaveBeenCalledWith({ toolsListChanged: true, resourceSubscriptions: ["doc://a"] });

    handlers.get("notifications/tools/list_changed")?.({ method: "notifications/tools/list_changed" });
    await stream.waitFor("notifications/tools/list_changed");
    handlers.get("notifications/resources/updated")?.({ params: { uri: "doc://a" } });
    expect(await stream.waitFor("notifications/resources/updated")).toMatchObject({ params: { uri: "doc://a" } });
    await stream.close();
  });

  it("starts no feed, and does not touch the real server, while forwarding is blocked", async () => {
    let opens = 0;
    const serve = (request: Request) =>
      serveMock(request, "mock1", door, {
        resolve: async () => resolvedMock({ definition, baseServerId: "real1" }),
        open: async (input) => {
          opens += 1;
          return open(input);
        },
        check: async () => ({ allowed: false, reason: "blocked_by_policy" }),
      });
    const stream = await openStream(serve, { toolsListChanged: true });
    await stream.waitFor("notifications/subscriptions/acknowledged");
    expect(opens).toBe(0);
    await stream.close();
  });
});
