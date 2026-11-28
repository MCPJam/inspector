/**
 * What the raw 2025-era probes do when the server hands an SSE stream to
 * polling.
 *
 * 2025-11-25 Transports, Sending Messages to the Server: after an event with
 * an ID, the server "MAY close the connection (without terminating the SSE
 * stream)", and the client "SHOULD then 'poll' the SSE stream by attempting to
 * reconnect", waiting the `retry` time first ("The client MUST respect the
 * retry field"). Resumability and Redelivery: the client resumes with "an
 * HTTP GET to the MCP endpoint" that carries `Last-Event-ID` (the same
 * section is in 2025-06-18 and 2025-03-26). 2026-07-28 streams are not
 * resumable, so nothing is called back there.
 *
 * Driven with a scripted `fetch`, so every request the probes send is seen.
 */

import { describe, expect, it } from "vitest";
import { runProtocolChecks } from "../../src/mcp-conformance/checks/protocol.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import { legacyInitialize } from "../../src/mcp-conformance/legacy-handshake.js";
import {
  jsonRpcResult,
  rawRequest,
  resumePolledStream,
} from "../../src/mcp-conformance/raw-http.js";
import { sseRetryMs } from "../../src/mcp-conformance/raw-capture.js";
import { WireObservationRecorder } from "../../src/mcp-conformance/wire-observations.js";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

type LegacyVersion = "2025-11-25" | "2025-06-18" | "2025-03-26";
const LEGACY_VERSIONS: LegacyVersion[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const SESSION = "session-1";

/** How the scripted server frames its answer to a POSTed request. */
type AnswerMode =
  | "json"
  /** An SSE stream that carries the answer. */
  | "sse"
  /** Hello MCP's `sse=poll`: a priming event with the answer in its id, then close. */
  | "poll"
  /** A notification with an event id, then the stream ends without the answer. */
  | "no-response"
  /** The connection is cut in the middle of the answer's frame. */
  | "cut"
  /** A priming event with an id, but HTTP 500. */
  | "poll-500";

/** What a GET carrying `Last-Event-ID` gets. */
type ResumeMode =
  /** Replay the answer named by the event id, then end the stream. */
  | "replay"
  /** Replay the answer and keep the stream open. */
  | "replay-open"
  | "405"
  | "500"
  /** One event with a new id and a new `retry`, then the stream breaks. */
  | "break-once"
  /** A response that belongs to another request, then 405. */
  | "wrong-id";

interface Sent {
  /** `POST <method>`, `GET`, `DELETE`. */
  line: string;
  headers: Headers;
  at: number;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function sse(
  text: string,
  status = 200,
  sessionId: string | null = SESSION
): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
  });
}

/** A stream that sends `text`, then fails mid-read. */
function brokenSse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      setTimeout(() => controller.error(new Error("connection reset")), 5);
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** A stream that sends `text` and never ends. */
function openSse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function encode(message: unknown): string {
  return Buffer.from(JSON.stringify(message), "utf8").toString("base64");
}

function decode(id: string): unknown {
  return JSON.parse(
    Buffer.from(id.slice("poll.".length), "base64").toString("utf8")
  );
}

/**
 * A correct 2025 server whose framing is scripted. `answeredVersion` is what
 * `initialize` answers with (the version asked for by default).
 */
function scriptedServer(options: {
  sent: Sent[];
  answer: AnswerMode;
  resume?: ResumeMode;
  retryMs?: number;
  answeredVersion?: string;
  /** The session id comes only on the call-back that carries the answer. */
  sessionOnCallback?: boolean;
}): typeof fetch {
  let gets = 0;
  const retry =
    options.retryMs === undefined ? "" : `retry: ${options.retryMs}\n`;
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    const httpMethod = init?.method ?? "GET";
    if (httpMethod !== "POST") {
      options.sent.push({ line: httpMethod, headers, at: Date.now() });
      const lastEventId = headers.get("last-event-id");
      if (httpMethod !== "GET" || !lastEventId) {
        return new Response(null, { status: 405 });
      }
      gets += 1;
      switch (options.resume ?? "replay") {
        case "wrong-id":
          return gets === 1
            ? sse(
                `id: 2\nevent: message\ndata: ${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 999,
                  result: { tools: [] },
                })}\n\n`
              )
            : new Response(null, { status: 405 });
        case "break-once":
          return gets === 1
            ? brokenSse("id: moved-1\nretry: 40\ndata: \n\n")
            : new Response(null, { status: 405 });
        case "405":
          return new Response(null, { status: 405 });
        case "500":
          return new Response("boom", { status: 500 });
        case "replay-open":
          return openSse(
            `id: 2\nevent: message\ndata: ${JSON.stringify(decode(lastEventId))}\n\n`
          );
        default:
          if (!lastEventId.startsWith("poll.")) {
            return new Response(null, { status: 405 });
          }
          return sse(
            `id: 2\nevent: message\ndata: ${JSON.stringify(decode(lastEventId))}\n\n`,
            200,
            options.sessionOnCallback ? "from-callback" : SESSION
          );
      }
    }

    const body = JSON.parse(String(init?.body));
    options.sent.push({ line: `POST ${body.method}`, headers, at: Date.now() });
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    const message =
      body.method === "initialize"
        ? {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion:
                options.answeredVersion ?? body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "scripted", version: "1" },
            },
          }
        : body.method === "tools/list"
          ? { jsonrpc: "2.0", id: body.id, result: { tools: [] } }
          : {
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "Method not found" },
            };

    switch (options.answer) {
      case "json":
        return json(message, { headers: { "mcp-session-id": SESSION } });
      case "sse":
        return sse(
          `id: 1\nevent: message\ndata: ${JSON.stringify(message)}\n\n`
        );
      case "poll":
        return sse(
          `id: poll.${encode(message)}\n${retry}data: \n\n`,
          200,
          options.sessionOnCallback ? null : SESSION
        );
      case "poll-500":
        return sse(`id: poll.${encode(message)}\n${retry}data: \n\n`, 500);
      case "no-response":
        return sse(
          `id: no-response.${body.id}\n${retry}event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "info", data: "Working on it" },
          })}\n\n`
        );
      case "cut":
        return sse(`id: 1\nevent: message\ndata: {"jsonrpc":"2.0","id":`);
    }
  };
}

function context(
  fetchFn: typeof fetch,
  protocolVersion: LegacyVersion | "2026-07-28" = "2025-11-25",
  checkTimeout = 2_000
): RawHttpCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://legacy.example.test/mcp",
    protocolVersion,
    checkTimeout,
    fetchFn,
  });
  return {
    config,
    serverUrl: config.serverUrl,
    fetchFn: config.fetchFn,
    recorder: new WireObservationRecorder(),
  };
}

function byId(results: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`no result for ${id}`);
  return found;
}

function gets(sent: Sent[]): Sent[] {
  return sent.filter((entry) => entry.line === "GET");
}

/** One POSTed `tools/list`, framed like the probes frame it. */
async function postToolsList(ctx: RawHttpCheckContext) {
  return await rawRequest(ctx, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": SESSION,
    },
    body: { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
  });
}

describe("sseRetryMs", () => {
  it("reads the last valid retry field and ignores bad ones", () => {
    expect(sseRetryMs("id: 1\nretry: 1000\ndata: \n\n")).toBe(1000);
    expect(sseRetryMs("retry: 10\n\nretry: 25\n\n")).toBe(25);
    expect(sseRetryMs("retry: 10\n\nretry: soon\n\n")).toBe(10);
    expect(sseRetryMs("id: 1\ndata: x\n\n")).toBeUndefined();
    // A stream that broke mid-line has not finished that field yet.
    expect(sseRetryMs("retry: 1000\n\nretry: 4")).toBe(1000);
  });
});

describe("resumePolledStream", () => {
  it("waits the retry time, then sends one GET with Last-Event-ID, the session id and the version", async () => {
    const sent: Sent[] = [];
    const ctx = context(scriptedServer({ sent, answer: "poll", retryMs: 60 }));
    const posted = await postToolsList(ctx);
    const result = await resumePolledStream(ctx, posted, {
      sessionId: SESSION,
      protocolVersion: "2025-11-25",
    });

    const [get] = gets(sent);
    expect(gets(sent)).toHaveLength(1);
    expect(get.headers.get("last-event-id")).toMatch(/^poll\./);
    expect(get.headers.get("accept")).toBe("text/event-stream");
    expect(get.headers.get("mcp-session-id")).toBe(SESSION);
    expect(get.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(get.at - sent[0].at).toBeGreaterThanOrEqual(55);

    // The answer joins the stream's events; the POST's own facts stay put.
    expect(result.sse?.map((event) => event.json)).toContainEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { tools: [] },
    });
    expect(result.status).toBe(posted.status);
    expect(result.bodyText).toBe(posted.bodyText);
    expect(result.exchange).toBe(posted.exchange);
    expect(result.resumed).toEqual({
      attempts: [200],
      lastEventId: get.headers.get("last-event-id"),
      gotResponse: true,
      sessionId: SESSION,
    });
  });

  it("records the resumed answer against the request it answers", async () => {
    const sent: Sent[] = [];
    const ctx = context(scriptedServer({ sent, answer: "poll", retryMs: 1 }));
    await resumePolledStream(ctx, await postToolsList(ctx), {
      sessionId: SESSION,
    });

    const resumed = ctx.recorder!.observations.filter((entry) =>
      entry.origin.startsWith("GET")
    );
    expect(resumed).toEqual([
      expect.objectContaining({
        requestMethod: "tools/list",
        id: 7,
        requestIdDeterminable: true,
        origin: "GET (resumed tools/list)",
      }),
    ]);
  });

  it.each<[AnswerMode, string]>([
    ["json", "a JSON answer"],
    ["sse", "an SSE answer that already holds the response"],
    ["cut", "a frame cut off before its delimiter"],
    ["poll-500", "a non-2xx answer"],
  ])("sends nothing for %s (%s)", async (answer) => {
    const sent: Sent[] = [];
    const ctx = context(scriptedServer({ sent, answer, retryMs: 1 }));
    const posted = await postToolsList(ctx);
    const result = await resumePolledStream(ctx, posted, {
      sessionId: SESSION,
    });

    expect(gets(sent)).toEqual([]);
    expect(result).toBe(posted);
  });

  it("sends nothing on 2026-07-28, where streams are not resumable", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", retryMs: 1 }),
      "2026-07-28"
    );
    const posted = await postToolsList(ctx);

    expect(await resumePolledStream(ctx, posted)).toBe(posted);
    expect(gets(sent)).toEqual([]);
  });

  it("does not call back early when the retry time is longer than the time left", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", retryMs: 5_000 }),
      "2025-11-25",
      300
    );
    const posted = await postToolsList(ctx);
    const result = await resumePolledStream(ctx, posted);

    expect(gets(sent)).toEqual([]);
    expect(result.sse).toEqual(posted.sse);
    expect(result.resumed).toMatchObject({
      attempts: [],
      gotResponse: false,
      waitTooLong: { waitMs: 5_000 },
    });
  });

  it("does not take another request's response as the answer", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", resume: "wrong-id", retryMs: 1 })
    );
    const result = await resumePolledStream(ctx, await postToolsList(ctx));

    expect(result.resumed).toMatchObject({
      attempts: [200, 405],
      gotResponse: false,
    });
    expect(jsonRpcResult(result)).toBeUndefined();
    // It is still on the wire record, just not tied to this request.
    expect(
      ctx.recorder!.observations.find((entry) => entry.id === 999)
    ).not.toHaveProperty("requestMethod");
  });

  it("stops after one GET when the server answers it with 405", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", resume: "405", retryMs: 1 })
    );
    const posted = await postToolsList(ctx);
    const result = await resumePolledStream(ctx, posted);

    expect(gets(sent)).toHaveLength(1);
    expect(result.sse).toEqual(posted.sse);
    expect(result.resumed).toMatchObject({
      attempts: [405],
      gotResponse: false,
    });
  });

  it("stops after two failed GETs in a row", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", resume: "500", retryMs: 1 })
    );
    const result = await resumePolledStream(ctx, await postToolsList(ctx));

    expect(gets(sent)).toHaveLength(2);
    expect(result.resumed).toMatchObject({
      attempts: [500, 500],
      gotResponse: false,
    });
  });

  it("after a call-back breaks, the next one resumes from its newest event at its retry time", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", resume: "break-once", retryMs: 1 })
    );
    const result = await resumePolledStream(ctx, await postToolsList(ctx));

    const [first, second] = gets(sent);
    expect(gets(sent)).toHaveLength(2);
    expect(first.headers.get("last-event-id")).toMatch(/^poll\./);
    expect(second.headers.get("last-event-id")).toBe("moved-1");
    expect(second.at - first.at).toBeGreaterThanOrEqual(35);
    expect(result.resumed).toMatchObject({
      attempts: [expect.stringContaining("stream error"), 405],
      lastEventId: "moved-1",
      gotResponse: false,
    });
  });

  it("returns as soon as the answer arrives on a GET stream that stays open", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({
        sent,
        answer: "poll",
        resume: "replay-open",
        retryMs: 1,
      }),
      "2025-11-25",
      10_000
    );
    const startedAt = Date.now();
    const result = await resumePolledStream(ctx, await postToolsList(ctx));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.resumed?.gotResponse).toBe(true);
  });
});

describe("raw probes on a server that hands its streams to polling", () => {
  it("detects a broadcast response delivered on a resumed stream", async () => {
    const fetch = scriptedServer({ sent: [], answer: "poll", retryMs: 1 });
    const reply = (id: number) => ({ jsonrpc: "2.0", id, result: { tools: [] } });
    const frame = (id: number) => `data: ${JSON.stringify(reply(id))}\n\n`;
    const otherStreamCursor = `poll.${encode(reply(1001))}`;
    const ctx = context(async (input, init) => {
      if (new Headers(init?.headers).get("Last-Event-ID") === otherStreamCursor) {
        return sse(frame(1000) + frame(1001));
      }
      return fetch(input, init);
    });

    const results = await runTransportChecks(
      ctx,
      new Set<MCPCheckId>(["server-sse-streams-functional"]),
    );

    expect(byId(results, "server-sse-streams-functional")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("same JSON-RPC message") },
      details: { streamIndexes: [0, 1] },
    });
  });

  it.each(LEGACY_VERSIONS)(
    "%s: the invalid-method probe gets its error by calling back",
    async (version) => {
      const sent: Sent[] = [];
      const ctx = context(
        scriptedServer({ sent, answer: "poll", retryMs: 1 }),
        version
      );
      const results = await runProtocolChecks(
        ctx,
        new Set<MCPCheckId>(["protocol-invalid-method-error"])
      );

      expect(byId(results, "protocol-invalid-method-error")).toMatchObject({
        status: "passed",
        details: expect.objectContaining({ errorCode: -32601 }),
      });
      // One call-back for the initialize answer, one for the probe's.
      expect(gets(sent)).toHaveLength(2);
      for (const get of gets(sent)) {
        expect(get.headers.get("mcp-session-id")).toBe(SESSION);
      }
    }
  );

  it.each(LEGACY_VERSIONS)(
    "%s: the three concurrent streams get their answers by calling back",
    async (version) => {
      const sent: Sent[] = [];
      const ctx = context(
        scriptedServer({ sent, answer: "poll", retryMs: 1 }),
        version
      );
      const results = await runTransportChecks(
        ctx,
        new Set<MCPCheckId>(["server-sse-streams-functional"])
      );

      expect(byId(results, "server-sse-streams-functional")).toMatchObject({
        status: "passed",
        details: expect.objectContaining({ resumedStreams: [0, 1, 2] }),
      });
      // initialize + the three tool lists.
      expect(gets(sent)).toHaveLength(4);
    }
  );

  it("checks 11 and 16 could not run when the wait the server asks for is longer than the check has", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", retryMs: 5_000 }),
      "2025-11-25",
      300
    );
    const protocol = await runProtocolChecks(
      ctx,
      new Set<MCPCheckId>(["protocol-invalid-method-error"])
    );
    const transport = await runTransportChecks(
      ctx,
      new Set<MCPCheckId>(["server-sse-streams-functional"])
    );

    for (const check of [
      byId(protocol, "protocol-invalid-method-error"),
      byId(transport, "server-sse-streams-functional"),
    ]) {
      expect(check).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
      });
      expect(check.error?.message).toContain("after 5000 ms");
    }
    expect(
      byId(transport, "server-sse-streams-functional").details
    ).toMatchObject({ unreadStreams: [0, 1, 2] });
    expect(gets(sent)).toEqual([]);
  });

  it("reads the answered version through a call-back, so the version stop still works", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({
        sent,
        answer: "poll",
        retryMs: 1,
        answeredVersion: "2099-01-01",
      })
    );

    const handshake = await legacyInitialize(ctx);
    expect(handshake.sessionId).toBe(SESSION);
    expect(handshake.versionStop?.answeredVersion).toBe("2099-01-01");

    const results = await runProtocolChecks(
      ctx,
      new Set<MCPCheckId>(["protocol-invalid-method-error"])
    );
    expect(byId(results, "protocol-invalid-method-error")).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(sent.map((entry) => entry.line)).not.toContain(
      "POST nonexistent/method_that_does_not_exist"
    );
  });

  it("keeps a session id that only the call-back carries", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({
        sent,
        answer: "poll",
        retryMs: 1,
        sessionOnCallback: true,
      })
    );
    const handshake = await legacyInitialize(ctx);

    expect(handshake.result.headers["mcp-session-id"]).toBeUndefined();
    expect(handshake.sessionId).toBe("from-callback");
    expect(handshake.result.resumed?.sessionId).toBe("from-callback");
  });

  it("reads the negotiated version through a call-back", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "poll", retryMs: 1 }),
      "2025-06-18"
    );
    const handshake = await legacyInitialize(ctx);

    expect(handshake.negotiatedVersion).toBe("2025-06-18");
    expect(handshake.versionStop).toBeUndefined();
    // Nothing is negotiated before the initialize answer, so no version header.
    expect(gets(sent)[0].headers.get("mcp-protocol-version")).toBeNull();
  });
});

describe("streams that are not handed to polling keep today's verdicts", () => {
  it.each<AnswerMode>(["json", "sse", "cut"])(
    "%s: no GET is sent",
    async (answer) => {
      const sent: Sent[] = [];
      const ctx = context(scriptedServer({ sent, answer, retryMs: 1 }));
      await runProtocolChecks(
        ctx,
        new Set<MCPCheckId>(["protocol-invalid-method-error"])
      );
      await runTransportChecks(
        ctx,
        new Set<MCPCheckId>(["server-sse-streams-functional"])
      );

      expect(gets(sent)).toEqual([]);
    }
  );

  it("a stream that ends without its answer gets one GET, and fails Functional SSE Streams", async () => {
    const sent: Sent[] = [];
    const ctx = context(
      scriptedServer({ sent, answer: "no-response", resume: "405", retryMs: 1 })
    );
    const protocol = await runProtocolChecks(
      ctx,
      new Set<MCPCheckId>(["protocol-invalid-method-error"])
    );
    const transport = await runTransportChecks(
      ctx,
      new Set<MCPCheckId>(["server-sse-streams-functional"])
    );

    expect(byId(protocol, "protocol-invalid-method-error")).toMatchObject({
      status: "failed",
      error: {
        message:
          "Server did not return a JSON-RPC error object for an invalid method",
      },
    });
    // The stream carried events but never the response to its request, and
    // the call-back found nothing more: the SHOULD it is graded on went unmet.
    expect(byId(transport, "server-sse-streams-functional")).toMatchObject({
      status: "failed",
      error: {
        message:
          "One or more concurrent SSE streams ended without the JSON-RPC response to its request",
      },
      details: { unansweredStreams: [0, 1, 2] },
    });
    expect(
      byId(transport, "server-sse-streams-functional").details
    ).not.toHaveProperty("resumedStreams");
    for (const get of gets(sent)) {
      expect(get.headers.get("last-event-id")).toMatch(/^no-response\.\d+$/);
    }
  });
});
