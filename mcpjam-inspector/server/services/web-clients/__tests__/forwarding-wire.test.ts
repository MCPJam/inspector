import { describe, expect, it } from "vitest";
import { NativeWireError } from "../../../utils/harness/forwarding/native-wire.js";
import {
  answerId,
  followedRedirect,
  observeBody,
  parseRpcBody,
  readBodyBytes,
} from "../forwarding-wire.js";

const encoder = new TextEncoder();

/** The upstream's SSE bytes, cut into chunks at `cuts`, relayed the way the endpoint relays them. */
async function relay(
  text: string,
  options: { cuts?: number[]; onMessage?: (message: unknown) => void } = {},
) {
  const bytes = encoder.encode(text);
  const edges = [0, ...(options.cuts ?? []), bytes.length];
  const observed: unknown[] = [];
  let ends = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 1; i < edges.length; i++)
        controller.enqueue(bytes.slice(edges[i - 1], edges[i]));
      controller.close();
    },
  });
  const stream = observeBody({
    body,
    kind: "sse",
    onMessage: (message) => {
      observed.push(message);
      options.onMessage?.(message);
    },
    onEnd: () => {
      ends += 1;
    },
  });
  const relayed = await new Response(stream).text();
  return { relayed, observed, ends };
}

function refusalOf(read: () => unknown): string | undefined {
  try {
    read();
  } catch (error) {
    return error instanceof NativeWireError ? error.code : String(error);
  }
  return undefined;
}

const parse = (text: string, headers: Record<string, string> = {}) =>
  parseRpcBody(encoder.encode(text), new Headers(headers));

const toolCall = (args: string, id = "1") =>
  `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"pay","arguments":${args}}}`;

describe("forwarding wire: reading the vendor's request", () => {
  it("refuses a tool call whose arguments hold a number JSON.parse would round", () => {
    for (const args of [
      '{"account":9007199254740993}',
      '{"rows":[1,{"id":-12345678901234567891}]}',
      '{"amount":1e400}',
    ])
      expect(refusalOf(() => parse(toolCall(args)))).toBe("rounded_number");
  });

  it("keeps numbers JSON.parse reads exactly, and large numbers outside a tool call's arguments", () => {
    for (const args of [
      '{"account":9007199254740991}',
      '{"account":9007199254740992}',
      '{"ratio":0.30000000000000004}',
      '{"big":1.5e300}',
      '{"account":"9007199254740993"}',
    ])
      expect(parse(toolCall(args)).messages).toHaveLength(1);
    expect(
      parse(toolCall('{"a":1}', "9007199254740993")).messages,
    ).toHaveLength(1);
    expect(
      parse(
        '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"file:///a","n":9007199254740993}}',
      ).messages,
    ).toHaveLength(1);
  });

  it("refuses Mcp-Method or Mcp-Name on a batch, which one header can't describe", () => {
    const batch = `[{"jsonrpc":"2.0","id":1,"method":"tools/list"},${toolCall('{"a":1}', "2")}]`;
    expect(refusalOf(() => parse(batch, { "mcp-method": "tools/call" }))).toBe(
      "header_mismatch",
    );
    expect(refusalOf(() => parse(batch, { "mcp-name": "pay" }))).toBe(
      "header_mismatch",
    );
    expect(parse(batch).batch).toBe(true);
  });

  it("refuses an oversized body as too large even when cancelling it fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        throw new Error("socket closed");
      },
    });
    // Node needs `duplex` for a streamed body; the DOM's RequestInit omits it.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      body,
      duplex: "half",
    };
    const request = new Request("https://inspector.example.test/mcp/c", init);
    await expect(readBodyBytes(request, 4)).rejects.toMatchObject({
      code: "request_too_large",
    });
  });
});

describe("forwarding wire: watching the server's answer", () => {
  const progress = {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: 3, progress: 1, total: 2 },
  };
  const result = {
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: "echo: ☃" }] },
  };

  it("correlates only a JSON-RPC 2.0 response with exactly one of a result or an error", () => {
    expect(answerId(result)).toBe(3);
    expect(
      answerId({ jsonrpc: "2.0", id: "a", error: { code: 1, message: "x" } }),
    ).toBe("a");
    expect(answerId({ id: 3, result: {} })).toBeUndefined();
    expect(answerId({ jsonrpc: "1.0", id: 3, result: {} })).toBeUndefined();
    expect(
      answerId({
        jsonrpc: "2.0",
        id: 3,
        result: {},
        error: { code: 1, message: "x" },
      }),
    ).toBeUndefined();
  });

  it("tells an answer that came through a redirect from the server's own", () => {
    const answer = (url: string, redirected = false) =>
      Object.defineProperties(new Response(null, { status: 401 }), {
        url: { value: url },
        redirected: { value: redirected },
      });
    const asked = "https://EXAMPLE.test:443/mcp#connector";
    expect(followedRedirect(answer("https://example.test/mcp"), asked)).toBe(
      false,
    );
    expect(followedRedirect(answer(""), asked)).toBe(false);
    expect(
      followedRedirect(answer("https://example.test/status/1"), asked),
    ).toBe(true);
    expect(
      followedRedirect(answer("https://example.test/mcp", true), asked),
    ).toBe(true);
  });

  it("reads a last event that ends in CR CR as the stream closes", async () => {
    const text = `event: message\rdata: ${JSON.stringify(result)}\r\r`;
    const { relayed, observed, ends } = await relay(text);
    expect(relayed).toBe(text);
    expect(observed).toEqual([result]);
    expect(ends).toBe(1);
  });

  it("reads the same events wherever the chunks are cut, an empty chunk included", async () => {
    const text =
      ": keepalive\r\n" +
      `event: message\r\ndata: ${JSON.stringify(progress)}\r\n\r\n` +
      `event: message\rdata: ${JSON.stringify(result).replace(",", ",\r\ndata: ")}\r\r`;
    const size = encoder.encode(text).length;
    for (let cut = 1; cut < size; cut++) {
      for (const cuts of [[cut], [cut, cut]]) {
        const { relayed, observed } = await relay(text, { cuts });
        expect(relayed).toBe(text);
        expect(observed).toEqual([progress, result]);
      }
    }
    const bytewise = await relay(text, {
      cuts: Array.from({ length: size - 1 }, (_, i) => i + 1),
    });
    expect(bytewise.observed).toEqual([progress, result]);
  });

  it("passes over an event larger than it reads, whole or in pieces, and still reads the next one", async () => {
    const big = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "x".repeat(8 * 1024 * 1024) },
    });
    const text = `data: ${big}\n\ndata: ${JSON.stringify(result)}\n\n`;
    // Whole; cut inside the event; cut once the event alone is over the limit.
    for (const cuts of [
      [],
      [Math.floor(big.length / 2)],
      [6 + big.length - 1],
    ]) {
      const { relayed, observed } = await relay(text, { cuts });
      expect(relayed === text).toBe(true);
      expect(observed).toEqual([result]);
    }
  });

  it("keeps relaying, and ends once, when the observer throws", async () => {
    const text = `data: ${JSON.stringify(progress)}\n\ndata: ${JSON.stringify(result)}\n\n`;
    const { relayed, observed, ends } = await relay(text, {
      cuts: [20],
      onMessage: () => {
        throw new Error("ledger unavailable");
      },
    });
    expect(relayed).toBe(text);
    expect(observed).toEqual([progress, result]);
    expect(ends).toBe(1);
  });
});
