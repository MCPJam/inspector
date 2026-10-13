/**
 * Ask MCPJam's browser-side capture: one decision per request, in `onFinish`,
 * for exactly the failures the server did not report.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentFailureTracker } from "../agent-failure-reporting";

const NOT_ABORTED = { isAbort: false, isDisconnect: false, isError: false };

function sse(chunks: unknown[], headers: Record<string, string> = {}) {
  const body = chunks
    .map(
      (chunk) =>
        `data: ${
          typeof chunk === "string" ? chunk : JSON.stringify(chunk)
        }\n\n`,
    )
    .join("");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-mcpjam-failure-captured": "0",
      ...headers,
    },
  });
}

/** Run one request through the tracker the way the Chat does. */
async function request(
  response: Response | Error,
  opts: { signal?: AbortSignal } = {},
) {
  const report = vi.fn(() => true);
  const tracker = createAgentFailureTracker(report as never);
  let consumed: Response | undefined;
  let rejected: unknown;
  try {
    consumed = await tracker.fetch(
      "/api/web/mcpjam-agent",
      opts.signal ? { signal: opts.signal } : {},
      async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    );
    // The SDK reads the whole body; the tracker sees it on the way past.
    await consumed.text();
  } catch (error) {
    rejected = error;
  }
  return { tracker, report, consumed, rejected };
}

describe("Ask MCPJam failure tracker", () => {
  it("captures a fetch that rejected while online, as routine transport", async () => {
    const { tracker, report, rejected } = await request(
      new TypeError("Failed to fetch"),
    );
    tracker.noteError(rejected as Error);

    tracker.onFinish({ isAbort: false, isDisconnect: true, isError: true });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      rejected,
      null,
      expect.objectContaining({
        agent: expect.objectContaining({
          source: "fetch_rejected",
          pageClass: "routine",
        }),
      }),
    );
  });

  it("does not capture Stop before the headers arrived", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error("The user aborted a request."), {
      name: "AbortError",
    });
    const { tracker, report } = await request(abort, {
      signal: controller.signal,
    });
    tracker.noteError(abort);

    // The SDK reports a pre-header Stop as an abort; even if it did not, the
    // request's own signal says so.
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).not.toHaveBeenCalled();
  });

  it("does not capture a Stop mid-stream", async () => {
    const { tracker, report } = await request(sse([{ type: "start" }]));
    tracker.onFinish({ isAbort: true, isDisconnect: false, isError: false });
    expect(report).not.toHaveBeenCalled();
  });

  it("captures a malformed chunk once", async () => {
    const { tracker, report } = await request(
      sse([{ type: "start" }, "{not json"]),
    );
    tracker.noteError(new Error("Invalid JSON"));
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });
    // A second terminal edge for the same request changes nothing.
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ ok: true, failureCaptured: false }),
      expect.objectContaining({
        agent: expect.objectContaining({ source: "stream_error" }),
      }),
    );
  });

  it("captures an empty body once, as a stream that never finished", async () => {
    const { tracker, report } = await request(sse([]));
    tracker.onFinish(NOT_ABORTED);

    expect(report).toHaveBeenCalledTimes(1);
    const options = (report.mock.calls[0] as unknown[])[2] as {
      agent: { source: string; pageClass?: string };
    };
    expect(options.agent.source).toBe("stream_incomplete");
    // Not transport: the stream arrived and said nothing. An incident.
    expect(options.agent.pageClass).toBeUndefined();
  });

  it("captures a disconnect once, as routine transport", async () => {
    const { tracker, report } = await request(sse([{ type: "start" }]));
    tracker.noteError(new TypeError("network error"));
    tracker.onFinish({ isAbort: false, isDisconnect: true, isError: true });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.anything(),
      expect.objectContaining({
        agent: expect.objectContaining({
          source: "disconnect",
          pageClass: "routine",
        }),
      }),
    );
  });

  it('treats WebKit\'s mid-stream "Load failed" as a disconnect, not an incident', async () => {
    // The SDK only flags isDisconnect for a TypeError naming fetch/network.
    const { tracker, report } = await request(sse([{ type: "start" }]));
    tracker.noteError(new TypeError("Load failed"));
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.anything(),
      expect.objectContaining({
        agent: expect.objectContaining({
          source: "disconnect",
          pageClass: "routine",
        }),
      }),
    );
  });

  it("does not capture an error chunk the server already captured", async () => {
    const { tracker, report } = await request(
      sse([
        { type: "start" },
        {
          type: "data-trace-event",
          data: { type: "error", errorText: "boom", captured: true },
          transient: true,
        },
        { type: "error", errorText: "boom" },
      ]),
    );
    tracker.noteError(new Error("boom"));
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).not.toHaveBeenCalled();
  });

  it("keeps an uncaptured error chunk an incident when the socket also drops", async () => {
    const { tracker, report } = await request(
      sse([
        { type: "start" },
        {
          type: "data-trace-event",
          data: { type: "error", errorText: "boom", captured: false },
          transient: true,
        },
        { type: "error", errorText: "boom" },
      ]),
    );
    tracker.noteError(new TypeError("network error"));
    tracker.onFinish({ isAbort: false, isDisconnect: true, isError: true });

    expect(report).toHaveBeenCalledTimes(1);
    const options = (report.mock.calls[0] as unknown[])[2] as {
      agent: { source: string; pageClass?: string };
    };
    // The server's failure, seen first: not demoted to a routine disconnect.
    expect(options.agent.source).toBe("stream_error");
    expect(options.agent.pageClass).toBeUndefined();
  });

  it("captures an error chunk the server did not", async () => {
    const { tracker, report } = await request(
      sse([
        { type: "start" },
        {
          type: "data-trace-event",
          data: { type: "error", errorText: "boom", captured: false },
          transient: true,
        },
        { type: "error", errorText: "boom" },
      ]),
    );
    tracker.noteError(new Error("boom"));
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not capture a failed request the server says it captured", async () => {
    const { tracker, report } = await request(
      new Response('{"code":"agent_turn_limit","gatedBy":"user"}', {
        status: 429,
        headers: { "x-mcpjam-failure-captured": "1" },
      }),
    );
    tracker.noteError(
      new Error('{"code":"agent_turn_limit","gatedBy":"user"}'),
    );
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).not.toHaveBeenCalled();
  });

  it("captures a failed request with no capture header, with its refusal", async () => {
    // An edge in front of the server replaced the response.
    const body = '{"code":"platform_capacity","scope":"platform"}';
    const { tracker, report } = await request(
      new Response(body, { status: 429 }),
    );
    tracker.noteError(new Error(body));
    tracker.onFinish({ isAbort: false, isDisconnect: false, isError: true });

    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ ok: false, status: 429 }),
      expect.objectContaining({
        agent: expect.objectContaining({
          source: "request_failed",
          code: "platform_capacity",
          scope: "platform",
        }),
      }),
    );
  });

  it("captures nothing for a turn that finished", async () => {
    const { tracker, report, consumed } = await request(
      sse([
        { type: "start" },
        { type: "text-delta", delta: "hi" },
        { type: "finish" },
      ]),
    );
    tracker.onFinish(NOT_ABORTED);

    expect(report).not.toHaveBeenCalled();
    // The body went through untouched.
    expect(consumed?.status).toBe(200);
  });
});
