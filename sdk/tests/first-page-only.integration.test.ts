import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import {
  stripNextCursorFromListResult,
  wrapTransportForFirstPageOnly,
} from "../src/mcp-client-manager/transport-utils.js";
import {
  serveMultiPageFixtureOnPort,
  type ServedMultiPageFixture,
} from "./support/multi-page-fixture.js";
import { getWireField } from "./support/raw-capture.js";

/**
 * `mcpProfile.paginationTraversal: "firstPageOnly"` — simulating the real
 * hosts that read page one of a list and stop.
 *
 * The fixture serves 3 pages of 4 per primitive on a real socket, so these
 * assert the truncation the way a server would observe it, not through a
 * mocked client. The interesting case is the SECOND-order effect: the
 * official client's page-one-only aggregate is what it caches, and that cache
 * is the source SEP-2243 `Mcp-Param-*` mirroring reads — so a page-2 tool
 * loses its mirrored header too.
 */

describe("first-page-only pagination (firstPageOnly: true)", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function connect(options: {
    firstPageOnly?: boolean;
    fixtureOptions?: Parameters<typeof serveMultiPageFixtureOnPort>[0];
  }) {
    served = await serveMultiPageFixtureOnPort(options.fixtureOptions ?? {});
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      ...(options.firstPageOnly !== undefined
        ? { firstPageOnly: options.firstPageOnly }
        : {}),
      timeout: 10_000,
    });
    return { served: served!, manager: manager! };
  }

  const listRequests = (method: string) =>
    served!.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === method
    );

  const toolCalls = () =>
    served!.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/call"
    );

  it("returns only page one and stops requesting further pages", async () => {
    const { manager } = await connect({ firstPageOnly: true });
    const result = await manager.listTools("fixture");

    expect(result.tools).toHaveLength(4);
    expect(result.tools.map((t) => t.name)).toEqual([
      "tool-0",
      "tool-1",
      "tool-2",
      "tool-3",
    ]);
    // The decisive wire fact: the client never asked for page 2.
    expect(listRequests("tools/list")).toHaveLength(1);
  });

  it("walks every page by default (control)", async () => {
    const { manager } = await connect({});
    const result = await manager.listTools("fixture");

    expect(result.tools).toHaveLength(12);
    expect(listRequests("tools/list").length).toBeGreaterThan(1);
  });

  it("truncates the other paginated primitives too", async () => {
    const { manager } = await connect({ firstPageOnly: true });

    expect((await manager.listPrompts("fixture")).prompts).toHaveLength(4);
    expect((await manager.listResources("fixture")).resources).toHaveLength(4);
    expect(listRequests("prompts/list")).toHaveLength(1);
    expect(listRequests("resources/list")).toHaveLength(1);
  });

  it("leaves explicit-cursor paging alone (the debugger's own manual paging)", async () => {
    // Truncating this would break a debugger feature rather than simulate a
    // client: an explicit cursor is an operator action, not something the
    // emulated client did on its own.
    const { manager } = await connect({ firstPageOnly: true });
    const page2 = await manager.listTools("fixture", { cursor: "page-1" });

    expect(page2.tools).toHaveLength(4);
    // Page 2 of 3 still advertises page 3 — the knob did not touch it.
    expect(page2.nextCursor).toBeDefined();
  });

  it("mirrors no Mcp-Param-* for a page-2 tool, surfacing the server's -32020", async () => {
    // The second-order effect and the whole point of the knob: the client
    // cached a page-one-only tools/list, so `tool-4`'s `x-mcp-header`
    // declaration is unreadable and its call goes out bare. A strict server
    // answers -32020, and MCPJam surfaces that rather than masking it.
    const { manager } = await connect({
      firstPageOnly: true,
      fixtureOptions: { requireParamHeaders: true },
    });
    await manager.listTools("fixture");

    await expect(
      manager.executeTool("fixture", "tool-4", { message: "hi" })
    ).rejects.toThrow(/-32020|header/i);

    const calls = toolCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)!.request.headers["mcp-param-message"]).toBeUndefined();
  });

  it("still mirrors for a page-1 tool under the same knob", async () => {
    // Proves the failure above is pagination-specific, not the knob breaking
    // mirroring wholesale.
    const { manager } = await connect({
      firstPageOnly: true,
      fixtureOptions: { requireParamHeaders: true },
    });
    await manager.listTools("fixture");
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    expect(toolCalls().at(-1)!.request.headers["mcp-param-message"]).toBe("hi");
  });

  it("mirrors for the SAME page-2 tool when the knob is off (control)", async () => {
    const { manager } = await connect({
      fixtureOptions: { requireParamHeaders: true },
    });
    await manager.listTools("fixture");
    await manager.executeTool("fixture", "tool-4", { message: "hi" });

    expect(toolCalls().at(-1)!.request.headers["mcp-param-message"]).toBe("hi");
  });
});

describe("stripNextCursorFromListResult (pure)", () => {
  it("removes nextCursor from a result", () => {
    const out = stripNextCursorFromListResult({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [], nextCursor: "page-1" },
    } as never) as { result: Record<string, unknown> };

    expect(out.result.nextCursor).toBeUndefined();
    expect(out.result.tools).toEqual([]);
  });

  it("returns the message by identity when there is nothing to strip", () => {
    // Identity matters: non-list traffic must be provably untouched.
    for (const message of [
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } },
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
      { jsonrpc: "2.0", id: 1, result: null },
    ] as never[]) {
      expect(stripNextCursorFromListResult(message)).toBe(message);
    }
  });
});

describe("wrapTransportForFirstPageOnly (correlation)", () => {
  function fakeInner() {
    const sent: unknown[] = [];
    const inner = {
      sent,
      async start() {},
      async send(message: unknown) {
        sent.push(message);
      },
      async close() {},
      onmessage: undefined as undefined | ((m: unknown) => void),
      onclose: undefined as undefined | (() => void),
      onerror: undefined as undefined | ((e: Error) => void),
    };
    return inner;
  }

  it("strips only for the id of a cursor-less list request", async () => {
    const inner = fakeInner();
    const wrapped = wrapTransportForFirstPageOnly(inner as never);
    const seen: unknown[] = [];
    wrapped.onmessage = (m) => seen.push(m);

    await wrapped.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    } as never);
    // An unrelated request that happens to answer with a nextCursor-shaped
    // result must NOT be touched.
    await wrapped.send({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "x" },
    } as never);

    inner.onmessage!({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [], nextCursor: "page-1" },
    });
    inner.onmessage!({
      jsonrpc: "2.0",
      id: 2,
      result: { contents: [], nextCursor: "not-a-list" },
    });

    expect((seen[0] as { result: Record<string, unknown> }).result.nextCursor)
      .toBeUndefined();
    expect((seen[1] as { result: Record<string, unknown> }).result.nextCursor)
      .toBe("not-a-list");
  });

  it("does not strip a list response fetched with an explicit cursor", async () => {
    const inner = fakeInner();
    const wrapped = wrapTransportForFirstPageOnly(inner as never);
    const seen: unknown[] = [];
    wrapped.onmessage = (m) => seen.push(m);

    await wrapped.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { cursor: "page-1" },
    } as never);
    inner.onmessage!({
      jsonrpc: "2.0",
      id: 7,
      result: { tools: [], nextCursor: "page-2" },
    });

    expect((seen[0] as { result: Record<string, unknown> }).result.nextCursor)
      .toBe("page-2");
  });

  it("forgets an id once answered, so a reused id is not re-stripped", async () => {
    const inner = fakeInner();
    const wrapped = wrapTransportForFirstPageOnly(inner as never);
    const seen: unknown[] = [];
    wrapped.onmessage = (m) => seen.push(m);

    await wrapped.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    } as never);
    inner.onmessage!({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    // Same id, now a different (non-list) request the manager issued later.
    inner.onmessage!({
      jsonrpc: "2.0",
      id: 1,
      result: { contents: [], nextCursor: "keep" },
    });

    expect((seen[1] as { result: Record<string, unknown> }).result.nextCursor)
      .toBe("keep");
  });
});
