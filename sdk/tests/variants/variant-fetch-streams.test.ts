/**
 * A `tools/list` answer can reach the client on any stream, not only the reply
 * to the POST that asked: on the GET stream (legacy HTTP+SSE), on a stream
 * resumed with `Last-Event-ID`, or inside another request's reply. And the
 * client matches it to its request by `Number(id)`. The variant must edit
 * every such answer, and refuse a page of tools it can't match.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  buildVariantDraft,
  createVariantFetch,
  type CreateVariantFetchOptions,
  type VariantTool,
} from "../../src/variants/index.js";

const URL_ = "https://base.test/mcp";
const TOOLS: VariantTool[] = [
  {
    name: "show_servers",
    description: "Show servers.",
    inputSchema: { type: "object" },
  },
  { name: "whoami", description: "Who am I.", inputSchema: { type: "object" } },
];
const EDITED = "Lists the servers across every project.";
const SERVED = [{ ...TOOLS[0], description: EDITED }, TOOLS[1]];
const REFUSAL = {
  code: -32090,
  message:
    "The base server changed tools this variant edits: show_servers. Create the variant again from the current server.",
  data: {
    code: "VARIANT_BASE_DRIFTED",
    tools: ["show_servers"],
    variantId: "variant-1",
  },
};

let variant: CreateVariantFetchOptions["variant"];

beforeAll(async () => {
  const { edits, toolHashes } = await buildVariantDraft({
    baseServerId: "base",
    tools: TOOLS,
    edits: [
      {
        feature: "tools.description",
        target: "show_servers",
        op: "set",
        value: EDITED,
      },
    ],
  });
  variant = { variantId: "variant-1", edits, toolHashes };
});

const encoder = new TextEncoder();
const rpc = (id: unknown, method: string) => ({ jsonrpc: "2.0", id, method });
const listAnswer = (id: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: { tools: structuredClone(TOOLS) },
});
const event = (message: unknown) => `data: ${JSON.stringify(message)}\n\n`;
const sse = (text: string, type = "text/event-stream") =>
  new Response(text, { headers: { "content-type": type } });
const post = (message: unknown): RequestInit => ({
  method: "POST",
  headers: { accept: "application/json, text/event-stream" },
  body: JSON.stringify(message),
});
const listen: RequestInit = {
  method: "GET",
  headers: { accept: "text/event-stream" },
};
const initialized = (id: unknown) =>
  Response.json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "base", version: "1.0.0" },
      },
    },
    { headers: { "mcp-session-id": "session-1" } }
  );

/** The JSON-RPC messages in an SSE body, skipping events without data. */
async function messagesIn(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {") || line.startsWith("data: ["))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

/** A base whose responses are queued in order. */
function queued(...responses: Response[]): typeof fetch {
  return async () => {
    const next = responses.shift();
    if (!next) throw new Error("the fake base has no response left");
    return next;
  };
}

/** Lists tools through a variant over `baseFetch` with the client the Inspector uses. */
async function listThroughVariant(
  baseFetch: typeof fetch,
  config: { url: string; mcpProtocolVersion?: "2025-11-25" }
) {
  const manager = new MCPClientManager();
  try {
    await manager.connectToServer("variant", {
      ...config,
      baseFetch: createVariantFetch({ baseFetch, variant }),
    });
    return (await manager.listTools("variant")).tools;
  } finally {
    await manager.disconnectAllServers();
  }
}

describe("createVariantFetch on every stream", () => {
  it("edits a tools/list answer resumed on the GET stream", async () => {
    const variantFetch = createVariantFetch({
      baseFetch: queued(
        sse("id: ev-1\nretry: 10\ndata: \n\n"),
        sse(event(listAnswer(1)))
      ),
      variant,
    });

    await (await variantFetch(URL_, post(rpc(1, "tools/list")))).text();
    const resumed = await variantFetch(URL_, {
      method: "GET",
      headers: { accept: "text/event-stream", "last-event-id": "ev-1" },
    });

    expect(await messagesIn(resumed)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: SERVED } },
    ]);
  });

  it("edits a tools/list answer that arrives in another request's reply", async () => {
    const call = { jsonrpc: "2.0", id: 2, result: { content: [] } };
    const variantFetch = createVariantFetch({
      baseFetch: queued(
        new Response(null, { status: 202 }),
        sse(event(listAnswer(1)) + event(call))
      ),
      variant,
    });

    await variantFetch(URL_, post(rpc(1, "tools/list")));
    const reply = await variantFetch(URL_, post(rpc(2, "tools/call")));

    expect(await messagesIn(reply)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: SERVED } },
      call,
    ]);
  });

  it("matches an answer by the number its id stands for, as the client does", async () => {
    const variantFetch = createVariantFetch({
      baseFetch: queued(
        Response.json(listAnswer("1")),
        Response.json(listAnswer(" 2"))
      ),
      variant,
    });

    const text = await variantFetch(URL_, post(rpc(1, "tools/list")));
    const spaced = await variantFetch(URL_, post(rpc(2, "tools/list")));

    expect(await text.json()).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: { tools: SERVED },
    });
    expect(await spaced.json()).toEqual({
      jsonrpc: "2.0",
      id: " 2",
      result: { tools: SERVED },
    });
  });

  it("refuses a page of tools that answers no tools/list it sent", async () => {
    const variantFetch = createVariantFetch({
      baseFetch: queued(
        Response.json(listAnswer(2)),
        sse(event(listAnswer(1)), "application/json")
      ),
      variant,
    });

    const call = await variantFetch(URL_, post(rpc(2, "tools/call")));
    // The client reads a GET it opened as SSE whatever the content type says.
    const stream = await variantFetch(URL_, listen);

    expect(await call.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: REFUSAL,
    });
    expect(await messagesIn(stream)).toEqual([
      { jsonrpc: "2.0", id: 1, error: REFUSAL },
    ]);
  });

  it("serves the edits to the client over legacy HTTP+SSE", async () => {
    let send: ((text: string) => void) | undefined;
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy", version: "1.0.0" },
      },
      "tools/list": { tools: TOOLS },
    };
    const legacy: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname;
      if ((init?.method ?? "GET") === "GET" && path === "/sse") {
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            send = (text) => controller.enqueue(encoder.encode(text));
          },
        });
        send?.("event: endpoint\ndata: /messages\n\n");
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      const message = JSON.parse(String(init?.body));
      const result = results[message.method];
      if (message.id !== undefined) {
        send?.(
          `event: message\n${event(
            result === undefined
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Method not found" },
                }
              : { jsonrpc: "2.0", id: message.id, result }
          )}`
        );
      }
      return new Response(null, { status: 202 });
    };

    const tools = await listThroughVariant(legacy, {
      url: "https://base.test/sse",
    });

    expect(
      tools.find((tool) => tool.name === "show_servers")?.description
    ).toBe(EDITED);
  });

  it("serves the edits to the client when the answer comes on a resumed GET stream", async () => {
    let listId: unknown;
    const polling: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Headers(init?.headers).get("last-event-id")
          ? sse(`id: ev-2\n${event(listAnswer(listId))}`)
          : new Response(null, { status: 405 });
      }
      const message = JSON.parse(String(init?.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "initialize") return initialized(message.id);
      if (message.method !== "tools/list")
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
      listId = message.id;
      // A priming event, then the stream closes before the answer is ready.
      return sse("id: ev-1\nretry: 10\ndata: \n\n");
    };

    const tools = await listThroughVariant(polling, {
      url: URL_,
      mcpProtocolVersion: "2025-11-25",
    });

    expect(
      tools.find((tool) => tool.name === "show_servers")?.description
    ).toBe(EDITED);
  });

  it("serves the edits to the client when the base answers with text ids", async () => {
    const textIds: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") !== "POST")
        return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "initialize") return initialized(message.id);
      if (message.method === "tools/list")
        return Response.json(listAnswer(String(message.id)));
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    };

    const tools = await listThroughVariant(textIds, {
      url: URL_,
      mcpProtocolVersion: "2025-11-25",
    });

    expect(
      tools.find((tool) => tool.name === "show_servers")?.description
    ).toBe(EDITED);
  });
});
