import { describe, expect, it } from "vitest";
import { WireObservationRecorder } from "../../src/mcp-conformance/wire-observations.js";
import type { RawExchange } from "../../src/mcp-conformance/raw-capture.js";

function exchange(options: {
  requestBody?: unknown;
  responseBody?: unknown;
  sse?: unknown[];
}): RawExchange {
  const bodyText =
    options.requestBody === undefined
      ? ""
      : JSON.stringify(options.requestBody);
  return {
    request: {
      method: "POST",
      url: "http://localhost/mcp",
      headers: {},
      bodyText,
      ...(options.requestBody !== undefined
        ? { json: options.requestBody }
        : {}),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      bodyText: "",
      ...(options.responseBody !== undefined
        ? { json: options.responseBody }
        : {}),
      ...(options.sse
        ? {
            sse: options.sse.map((json) => ({
              data: JSON.stringify(json),
              json,
              terminated: true,
            })),
          }
        : {}),
    },
  };
}

describe("correlating a response to the request it answers", () => {
  it("attaches the request method when the ids match", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", id: 7, method: "tools/list" },
        responseBody: { jsonrpc: "2.0", id: 7, result: { tools: [] } },
      }),
    );
    expect(recorder.observations[0]).toMatchObject({
      requestMethod: "tools/list",
      id: 7,
      requestIdDeterminable: true,
    });
  });

  it("pairs ids across types, so a stringified echo still correlates", () => {
    // A server that echoes `1` as `"1"` is loose with the wire; refusing to
    // pair would silently downgrade it to the near-vacuous generic validation —
    // going quiet against exactly the servers worth checking.
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        responseBody: { jsonrpc: "2.0", id: "1", result: { tools: [] } },
      }),
    );
    expect(recorder.observations[0].requestMethod).toBe("tools/list");
  });

  it("records the cross-type pairing as an id-echo mismatch, so tolerance does not hide it", () => {
    // Pairing loosely keeps the validation method-specific; it must not also
    // make the wrong echo disappear. `RequestId` admits both types, so no
    // schema can state this — "the response MUST contain the same ID as the
    // request", and 1 and "1" are different JSON values.
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        responseBody: { jsonrpc: "2.0", id: "1", result: { tools: [] } },
      }),
    );
    expect(recorder.observations[0].idEchoMismatch).toEqual({
      sent: 1,
      echoed: "1",
    });
  });

  it("records no mismatch when the echo is exact", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", id: 7, method: "tools/list" },
        responseBody: { jsonrpc: "2.0", id: 7, result: { tools: [] } },
      }),
    );
    expect(recorder.observations[0].idEchoMismatch).toBeUndefined();
  });

  it("never attaches a method to a notification", () => {
    // A notification answers nothing; attributing it to the exchange's request
    // would make the validator grade it as that method's RESULT.
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", id: 1, method: "tools/call" },
        sse: [
          { jsonrpc: "2.0", method: "notifications/message", params: {} },
          { jsonrpc: "2.0", id: 1, result: { content: [] } },
        ],
      }),
    );
    expect(recorder.observations.map((o) => o.requestMethod)).toEqual([
      undefined,
      "tools/call",
    ]);
  });

  it("does not correlate a response whose id matches nothing", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        responseBody: { jsonrpc: "2.0", id: 99, result: {} },
      }),
    );
    expect(recorder.observations[0].requestMethod).toBeUndefined();
  });
});

describe("request-id determinability", () => {
  it("is false when the request body did not parse", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        responseBody: {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
      }),
    );
    expect(recorder.observations[0].requestIdDeterminable).toBe(false);
  });

  it("is false when the request carried no id", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({
        requestBody: { jsonrpc: "2.0", method: "notifications/initialized" },
        responseBody: { jsonrpc: "2.0", id: null, error: { code: -1, message: "x" } },
      }),
    );
    expect(recorder.observations[0].requestIdDeterminable).toBe(false);
  });
});

describe("stream messages", () => {
  it("records frames the buffering capture cannot see", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordStreamMessages(
      [
        { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged" },
        { jsonrpc: "2.0", id: 8000, result: {} },
      ],
      {
        origin: "subscriptions/listen stream",
        requestMethod: "subscriptions/listen",
        requestId: 8000,
      },
    );
    expect(recorder.size).toBe(2);
    expect(recorder.observations[1].requestMethod).toBe("subscriptions/listen");
    expect(recorder.observations[0].requestMethod).toBeUndefined();
  });
});

describe("nothing to record", () => {
  it("records nothing for a body-less response", () => {
    const recorder = new WireObservationRecorder();
    recorder.recordExchange(
      exchange({ requestBody: { jsonrpc: "2.0", method: "x" } }),
    );
    expect(recorder.size).toBe(0);
  });
});
