/**
 * Client rules about pagination: cursors are opaque, the server picks the page
 * size, long lists are walked to the end, and a missing `nextCursor` ends it.
 *
 * The server below pages tools, prompts and resources UNEVENLY (3, then 1,
 * then 5 items) and hands out cursors a client might be tempted to touch:
 * spaces at the ends, non-ASCII, `%2F`, `+` and `=`. A client that trims,
 * decodes or re-encodes a cursor asks for a page that does not exist and gets
 * an error. Both stacks are covered: MCPClientManager (the official client)
 * and the raw modern tools walk the conformance checks use.
 */

import { describe, expect, it } from "vitest";
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  recordingFetch,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  runOneCheck,
  type WireRequest,
} from "./harness.js";

const PAGES = [["a", "b", "c"], ["d"], ["e", "f", "g", "h", "i"]];
/** The cursor that asks for page i. Page 0 is asked for with no cursor. */
const CURSORS = [undefined, " c/ñ ?=+%2F== ", "page two"];
const ALL_ITEMS = PAGES.flat();

function page(cursor: unknown): { names: string[]; nextCursor?: string } {
  const index = CURSORS.indexOf(cursor as string | undefined);
  if (index < 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown cursor ${JSON.stringify(cursor)}`,
    );
  }
  const nextCursor = CURSORS[index + 1];
  return { names: PAGES[index]!, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function buildOddPagesServer(): Server {
  const server = new Server(
    { name: "client-rules-odd-pages", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  server.setRequestHandler("tools/list", (request: any) => {
    const { names, nextCursor } = page(request?.params?.cursor);
    return {
      tools: names.map((name) => ({
        name: `tool-${name}`,
        inputSchema: { type: "object" as const, properties: {} },
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });
  server.setRequestHandler("prompts/list", (request: any) => {
    const { names, nextCursor } = page(request?.params?.cursor);
    return {
      prompts: names.map((name) => ({ name: `prompt-${name}` })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });
  server.setRequestHandler("resources/list", (request: any) => {
    const { names, nextCursor } = page(request?.params?.cursor);
    return {
      resources: names.map((name) => ({ uri: `test://${name}`, name: `resource-${name}` })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });
  return server;
}

const ERAS = ["2025-11-25", "2026-07-28"] as const;

/** List everything through MCPClientManager, recording the wire. */
async function listEverything(era: (typeof ERAS)[number]) {
  const handler = createMcpHandler(() => buildOddPagesServer());
  const sent: WireRequest[] = [];
  const manager = new MCPClientManager();
  try {
    await manager.connectToServer("odd", {
      url: "http://localhost/mcp",
      mcpProtocolVersion: era,
      baseFetch: recordingFetch((request) => handler.fetch(request), sent, () => era),
      timeout: 10_000,
    });
    const tools = await manager.listTools("odd");
    const prompts = await manager.listPrompts("odd");
    const resources = await manager.listResources("odd");
    return {
      sent,
      tools: tools.tools.map((tool) => tool.name),
      prompts: prompts.prompts.map((prompt) => prompt.name),
      resources: resources.resources.map((resource) => resource.name),
    };
  } finally {
    await manager.disconnectAllServers().catch(() => {});
  }
}

function cursorsSent(sent: WireRequest[], method: string): unknown[] {
  return sent
    .filter((request) => rpcMethodOf(request) === method)
    .map((request) => rpcOf(request)!.params?.cursor);
}

it("(control) the server refuses a cursor that was trimmed or decoded", () => {
  expect(() => page(CURSORS[1]!.trim())).toThrow(/Unknown cursor/);
  expect(() => page(decodeURIComponent(CURSORS[1]!))).toThrow(/Unknown cursor/);
  expect(page(CURSORS[1]).names).toEqual(PAGES[1]);
});

describe.each(ERAS)("the official client on %s", (era) => {
  ruleTest(
    "C012",
    "sends every cursor back exactly as the server wrote it",
    async () => {
      const { sent } = await listEverything(era);
      for (const method of ["tools/list", "prompts/list", "resources/list"]) {
        expect(cursorsSent(sent, method), method).toEqual(CURSORS);
      }
    },
  );

  ruleTest(
    "C013",
    "takes pages of 3, then 1, then 5 items without stopping at a short page",
    async () => {
      // A client that assumed the first page's size would stop after the
      // one-item second page and miss the last five.
      const { tools, resources } = await listEverything(era);
      expect(tools).toEqual(ALL_ITEMS.map((name) => `tool-${name}`));
      expect(resources).toEqual(ALL_ITEMS.map((name) => `resource-${name}`));
    },
  );

  ruleTest("C019", "walks a long prompt list to the end", async () => {
    const { prompts } = await listEverything(era);
    expect(prompts).toEqual(ALL_ITEMS.map((name) => `prompt-${name}`));
  });

  ruleTest(
    "C070",
    "stops at the page with no nextCursor: one request per page, no more",
    async () => {
      const { sent } = await listEverything(era);
      for (const method of ["tools/list", "prompts/list", "resources/list"]) {
        expect(cursorsSent(sent, method), method).toHaveLength(PAGES.length);
      }
    },
  );
});

describe("the raw modern tools walk the conformance checks use", () => {
  async function walkWithCheck(check: string): Promise<WireRequest[]> {
    const handler = createMcpHandler(() => buildOddPagesServer());
    const sent: WireRequest[] = [];
    await runOneCheck(check, {
      serverUrl: "http://localhost/mcp",
      protocolVersion: "2026-07-28",
      fetchFn: recordingFetch((request) => handler.fetch(request), sent, () => check),
    });
    // Only the raw probes' own walk: the official client's ids are small integers.
    return sent.filter(
      (request) =>
        rpcMethodOf(request) === "tools/list" && Number(rpcOf(request)!.id) >= 7000,
    );
  }

  ruleTest(
    "C012",
    "the raw walk sends every cursor back exactly as the server wrote it",
    async () => {
      const walk = await walkWithCheck("tools-x-mcp-header-declarations-valid");
      expect(walk.map((request) => rpcOf(request)!.params?.cursor)).toEqual(CURSORS);
    },
  );

  ruleTest(
    "C070",
    "the raw walk stops at the page with no nextCursor",
    async () => {
      const walk = await walkWithCheck("tools-x-mcp-header-declarations-valid");
      expect(walk).toHaveLength(PAGES.length);
    },
  );
});
