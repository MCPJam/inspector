import { describe, expect, it, vi } from "vitest";
import { NativeWireError } from "../../../utils/harness/forwarding/native-wire.js";
import {
  answerId,
  fetchWhileTurnOpen,
  followedRedirect,
  observeBody,
  parseRpcBody,
  readBodyBytes,
  TurnClosedError,
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
      '{"account":9007199254740993.0}',
      '{"account":9.007199254740993e15}',
      '{"ratio":0.3000000000000000444}',
      '{"tiny":1e-400}',
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
      '{"account":9007199254740992.0,"ratio":0.1,"hundred":1E2,"zero":-0}',
      '{"smallest":5e-324,"price":1234567.12345678}',
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
    expect(refusalOf(() => parse(batch, { "mcp-param-region": "eu" }))).toBe(
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

  it("reads an event whose data is exactly the limit, wherever the chunks cut it", async () => {
    const shell = { jsonrpc: "2.0", id: 9, result: { text: "" } };
    const pad = 8 * 1024 * 1024 - JSON.stringify(shell).length;
    const exact = { ...shell, result: { text: "x".repeat(pad) } };
    const data = JSON.stringify(exact);
    const text = `data: ${data}\n\n`;
    // Whole, and cut once the line with its prefix is over the limit.
    for (const cuts of [[], [6 + data.length - 1]]) {
      const { observed } = await relay(text, { cuts });
      expect(observed).toEqual([exact]);
    }
  });

  it("ignores a comment line larger than it reads, wherever the chunks cut it", async () => {
    const comment = `: ${"x".repeat(8 * 1024 * 1024 + 10)}`;
    const text = `data: ${JSON.stringify(result)}\n${comment}\n\n`;
    const start = text.indexOf(comment);
    const past = start + 8 * 1024 * 1024 + 5;
    for (const cuts of [[], [past], [start + 3, past]]) {
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

describe("forwarding wire: following a redirect hop by hop", () => {
  const hop = (status: number, location: string) =>
    new Response(null, { status, headers: { location } });
  type Sent = { url: string; init: RequestInit; headers: Headers };
  function upstream(answers: Response[]) {
    const sent: Sent[] = [];
    const fetchUpstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      sent.push({
        url: String(input),
        init: init ?? {},
        headers: new Headers(init?.headers),
      });
      return answers.shift() ?? Response.error();
    }) as typeof fetch;
    return { sent, fetchUpstream };
  }
  const body = encoder.encode('{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
  const init = {
    method: "POST",
    body,
    headers: {
      authorization: "Bearer project",
      "x-api-key": "project-key",
      "content-type": "application/json",
    },
  };

  it("sends the same request on, and drops credentials when it leaves the origin", async () => {
    const { sent, fetchUpstream } = upstream([
      hop(307, "/moved"),
      hop(308, "https://other.example.test/mcp"),
      Response.json({ ok: true }),
    ]);
    const response = await fetchWhileTurnOpen(
      fetchUpstream,
      "https://server.example.test/mcp",
      init,
      () => true,
      ["x-api-key"],
    );
    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    expect(
      sent.map(({ url, init, headers }) => [
        url,
        init.method,
        init.redirect,
        init.body === body,
        headers.get("authorization"),
      ]),
    ).toEqual([
      [
        "https://server.example.test/mcp",
        "POST",
        "manual",
        true,
        "Bearer project",
      ],
      [
        "https://server.example.test/moved",
        "POST",
        "manual",
        true,
        "Bearer project",
      ],
      ["https://other.example.test/mcp", "POST", "manual", true, null],
    ]);
    // The server's own key stays with its origin; protocol headers go on.
    expect(sent.map(({ headers }) => headers.get("x-api-key"))).toEqual([
      "project-key",
      "project-key",
      null,
    ]);
    expect(sent[2]?.headers.get("content-type")).toBe("application/json");
  });

  it("turns the request into a GET without its body on a 303, which needs no turn", async () => {
    const { sent, fetchUpstream } = upstream([
      hop(303, "/result"),
      new Response("done"),
    ]);
    const turnOpen = vi.fn(() => false);
    const response = await fetchWhileTurnOpen(
      fetchUpstream,
      "https://server.example.test/mcp",
      init,
      turnOpen,
    );
    expect(await response.text()).toBe("done");
    expect(sent[1]?.init).toMatchObject({ method: "GET", body: undefined });
    expect(sent[1]?.headers.get("content-type")).toBeNull();
    expect(turnOpen).not.toHaveBeenCalled();
  });

  it("sends nothing more once the turn has closed, and says the server took the call first", async () => {
    const { sent, fetchUpstream } = upstream([hop(307, "/moved")]);
    const error = await fetchWhileTurnOpen(
      fetchUpstream,
      "https://server.example.test/mcp",
      init,
      () => false,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TurnClosedError);
    expect(error).toMatchObject({ upstreamStatus: 307, afterRedirect: true });
    expect(sent).toHaveLength(1);
  });
});
