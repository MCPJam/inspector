import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildVariantDraft,
  createVariantFetch,
  type CreateVariantFetchOptions,
  type VariantTool,
} from "../../src/variants/index.js";

const URL_ = "https://base.test/mcp";
const SHOW: VariantTool = {
  name: "show_servers",
  description: "Show servers — “quoted” ünïcode",
  inputSchema: { type: "object", properties: { project: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const LIST: VariantTool = {
  name: "list_project_servers",
  description: "List servers.",
  inputSchema: { type: "object" },
};
const UNEDITED: VariantTool = { name: "whoami", inputSchema: {} };
const NEW_SHOW = "Lists servers across every project.";
const NEW_LIST = "Lists the servers saved in one project.";

let variant: CreateVariantFetchOptions["variant"];

beforeAll(async () => {
  const { edits, toolHashes } = await buildVariantDraft({
    baseServerId: "base",
    tools: [SHOW, LIST, UNEDITED],
    edits: Object.entries({
      show_servers: NEW_SHOW,
      list_project_servers: NEW_LIST,
    }).map(([target, value]) => ({
      feature: "tools.description",
      target,
      op: "set",
      value,
    })),
  });
  variant = { variantId: "variant-1", edits, toolHashes };
});

const clone = <T>(value: T): T => structuredClone(value);
const rpc = (id: number, method: string, params?: object) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const page = (id: number, tools: VariantTool[], nextCursor?: string) => ({
  jsonrpc: "2.0",
  id,
  result: { tools: clone(tools), ...(nextCursor ? { nextCursor } : {}) },
});
const post = (message: unknown, headers: HeadersInit = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(message),
});
const json = (message: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(message);
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      ...headers,
    },
  });
};
const edited = (tool: VariantTool, description: string) => ({
  ...clone(tool),
  description,
});
const drifted = (id: number, tools: string[]) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code: -32090,
    message: `The base server changed tools this variant edits: ${tools.join(", ")}. Create the variant again from the current server.`,
    data: { code: "VARIANT_BASE_DRIFTED", tools, variantId: "variant-1" },
  },
});

/** A base whose responses are queued in order, and that records what it was sent. */
function fakeBase(...responses: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("the fake base has no response left");
    return next;
  });
}

/** A stream the test feeds by hand, so it can show output arriving before the end. */
function manualStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (started) => {
      controller = started;
    },
  });
  return {
    stream,
    push: (bytes: Uint8Array) => controller?.enqueue(bytes),
    close: () => controller?.close(),
  };
}

function readerOf(response: Response) {
  if (!response.body) throw new Error("the response has no body");
  return response.body.getReader();
}

describe("createVariantFetch", () => {
  it("rewrites a JSON tools/list response and changes nothing else", async () => {
    const base = fakeBase(
      json(page(1, [SHOW, UNEDITED, LIST]), { "mcp-session-id": "s-1" })
    );
    const response = await createVariantFetch({ baseFetch: base, variant })(
      URL_,
      post(rpc(1, "tools/list"))
    );

    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [edited(SHOW, NEW_SHOW), UNEDITED, edited(LIST, NEW_LIST)],
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("s-1");
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("rewrites a tools/list event split across chunks and streams the other events as they were", async () => {
    const progress =
      'event: message\nid: ev-1\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n';
    // A server-to-client request reuses the client's id 7 from its own sequence.
    const elicit =
      'data: {"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{}}\r\n\r\n';
    const answer = `event: message\r\nid: ev-2\r\ndata: ${JSON.stringify(page(7, [SHOW, LIST]))}\r\n\r\n`;
    const bytes = new TextEncoder().encode(progress + elicit + answer);
    const dash =
      new TextEncoder().encode(
        progress + elicit + answer.slice(0, answer.indexOf("—"))
      ).byteLength + 1;
    const lastCr = bytes.byteLength - 2;
    const base = manualStream();
    const baseFetch = fakeBase(
      new Response(base.stream, {
        headers: { "content-type": "text/event-stream" },
      })
    );

    const response = await createVariantFetch({ baseFetch, variant })(
      URL_,
      post(rpc(7, "tools/list"))
    );
    const reader = readerOf(response);
    base.push(bytes.slice(0, 40));
    base.push(
      bytes.slice(40, new TextEncoder().encode(progress).byteLength + 3)
    );
    // The first event goes out before the stream ends, byte for byte.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      progress
    );
    base.push(
      bytes.slice(new TextEncoder().encode(progress).byteLength + 3, dash)
    );
    base.push(bytes.slice(dash, lastCr));
    base.push(bytes.slice(lastCr, lastCr + 1));
    base.push(bytes.slice(lastCr + 1));
    base.close();
    const decoder = new TextDecoder();
    let rest = "";
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      rest += decoder.decode(chunk.value, { stream: true });
    }

    expect(rest).toBe(
      `${elicit}event: message\nid: ev-2\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        result: { tools: [edited(SHOW, NEW_SHOW), edited(LIST, NEW_LIST)] },
      })}\n\n`
    );
  });

  it("rewrites the tools/list answer in a batch and leaves the other answer alone", async () => {
    const call = {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "ok" }] },
    };
    const base = fakeBase(json([page(1, [SHOW, LIST]), call]));
    const response = await createVariantFetch({ baseFetch: base, variant })(
      URL_,
      post([
        rpc(1, "tools/list"),
        rpc(2, "tools/call", { name: "show_servers", arguments: {} }),
      ])
    );

    expect(await response.json()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [edited(SHOW, NEW_SHOW), edited(LIST, NEW_LIST)] },
      },
      call,
    ]);
  });

  it("follows one listing across two pages", async () => {
    const base = fakeBase(
      json(page(1, [SHOW, UNEDITED], "page-2")),
      json(page(2, [LIST]))
    );
    const variantFetch = createVariantFetch({ baseFetch: base, variant });

    const first = await variantFetch(URL_, post(rpc(1, "tools/list")));
    const second = await variantFetch(
      URL_,
      post(rpc(2, "tools/list", { cursor: "page-2" }))
    );

    expect(await first.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [edited(SHOW, NEW_SHOW), UNEDITED],
        nextCursor: "page-2",
      },
    });
    expect(await second.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [edited(LIST, NEW_LIST)] },
    });
  });

  it("passes every other response through as it came, still streaming", async () => {
    const callStream = manualStream();
    const sse = { headers: { "content-type": "text/event-stream" } };
    const result = { jsonrpc: "2.0", id: 5, result: { content: [] } };
    const accepted = new Response(null, { status: 202 });
    const failed = new Response(JSON.stringify(page(4, [SHOW])), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const base = fakeBase(
      new Response(callStream.stream, sse),
      new Response(": keep-alive\n\n", sse),
      json(result),
      accepted,
      failed
    );
    const variantFetch = createVariantFetch({ baseFetch: base, variant });

    const call = await variantFetch(URL_, post(rpc(3, "tools/call")));
    const reader = readerOf(call);
    const progress = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`;
    callStream.push(new TextEncoder().encode(progress));
    // The event arrives while the base's stream is still open.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      progress
    );
    await reader.cancel();

    const listen = await variantFetch(URL_, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(await listen.text()).toBe(": keep-alive\n\n");
    const answer = await variantFetch(URL_, post(rpc(5, "tools/call")));
    expect(await answer.text()).toBe(JSON.stringify(result));
    expect(
      await variantFetch(
        URL_,
        post({ jsonrpc: "2.0", method: "notifications/initialized" })
      )
    ).toBe(accepted);
    expect(await variantFetch(URL_, post(rpc(4, "tools/list")))).toBe(failed);
  });

  it("answers VARIANT_BASE_DRIFTED when an edited tool changed", async () => {
    const changed = {
      ...SHOW,
      inputSchema: { type: "object", properties: {} },
    };
    const base = fakeBase(json(page(1, [changed, LIST])));
    const response = await createVariantFetch({ baseFetch: base, variant })(
      URL_,
      post(rpc(1, "tools/list"))
    );

    expect(await response.json()).toEqual(drifted(1, ["show_servers"]));
  });

  it("serves the edits when only a tool it doesn't edit changed", async () => {
    const changed = { ...UNEDITED, description: "Now described." };
    const base = fakeBase(json(page(1, [SHOW, LIST, changed])));
    const response = await createVariantFetch({ baseFetch: base, variant })(
      URL_,
      post(rpc(1, "tools/list"))
    );

    expect(await response.json()).toEqual(
      page(1, [edited(SHOW, NEW_SHOW), edited(LIST, NEW_LIST), changed])
    );
  });

  it("answers VARIANT_BASE_DRIFTED on the last page when an edited tool never appeared", async () => {
    const base = fakeBase(
      json(page(1, [SHOW], "page-2")),
      json(page(2, [UNEDITED])),
      json(page(3, [LIST]))
    );
    const variantFetch = createVariantFetch({ baseFetch: base, variant });

    const first = await variantFetch(URL_, post(rpc(1, "tools/list")));
    const last = await variantFetch(
      URL_,
      post(rpc(2, "tools/list", { cursor: "page-2" }))
    );
    const single = await variantFetch(URL_, post(rpc(3, "tools/list")));

    expect(await first.json()).toEqual(
      page(1, [edited(SHOW, NEW_SHOW)], "page-2")
    );
    expect(await last.json()).toEqual(drifted(2, ["list_project_servers"]));
    expect(await single.json()).toEqual(drifted(3, ["show_servers"]));
  });

  it("forwards each request to the base exactly as it came, credentials included", async () => {
    const base = fakeBase(
      json(page(1, [SHOW, LIST])),
      json({ jsonrpc: "2.0", id: 2, result: {} }),
      json(page(3, [SHOW, LIST]))
    );
    const variantFetch = createVariantFetch({ baseFetch: base, variant });
    const signal = new AbortController().signal;
    const headers = new Headers({
      authorization: "Bearer secret-token",
      "x-tenant-key": "tenant",
      "mcp-session-id": "s-1",
    });
    const list = { ...post(rpc(1, "tools/list")), headers, signal };
    const call = {
      ...post(
        rpc(2, "tools/call", {
          name: "show_servers",
          arguments: { project: "p" },
        })
      ),
      headers,
      signal,
    };
    const request = new Request(
      URL_,
      post(rpc(3, "tools/list"), { authorization: "Bearer other-token" })
    );

    await variantFetch(URL_, list);
    await variantFetch(URL_, call);
    await variantFetch(request);

    expect(base.mock.calls[0][0]).toBe(URL_);
    expect(base.mock.calls[0][1]).toBe(list);
    expect(base.mock.calls[1][1]).toBe(call);
    expect(
      new Headers(base.mock.calls[1][1]?.headers).get("authorization")
    ).toBe("Bearer secret-token");
    expect(base.mock.calls[2][0]).toBe(request);
    expect(base.mock.calls[2][1]).toBeUndefined();
    // Reading the body to match ids left the forwarded request unread.
    expect(request.headers.get("authorization")).toBe("Bearer other-token");
    expect(await request.text()).toBe(JSON.stringify(rpc(3, "tools/list")));
  });

  it("refuses a streamed request body it can't read without consuming", async () => {
    const base = fakeBase();
    const init: RequestInit = {
      method: "POST",
      body: new ReadableStream<Uint8Array>(),
    };
    const send = createVariantFetch({ baseFetch: base, variant })(URL_, init);

    await expect(send).rejects.toThrow(TypeError);
    expect(base).not.toHaveBeenCalled();
  });
});
