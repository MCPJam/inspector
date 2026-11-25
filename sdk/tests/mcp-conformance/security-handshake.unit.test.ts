/**
 * What follows the `initialize` a host-header probe sends by hand.
 *
 * "After successful initialization, the client MUST send an `initialized`
 * notification." These pin the decision for each kind of answer: finish the
 * handshake, disconnect, or send no notification. They also pin the one body
 * decoder the decision reads with, which the raw capture uses too.
 */

import {
  followUpTimeoutMs,
  planHandshakeFollowUp,
} from "../../src/mcp-conformance/checks/security-handshake.js";
import {
  decodeResponseBody,
  isEventStream,
} from "../../src/mcp-conformance/raw-capture.js";
import {
  jsonRpcError,
  jsonRpcResult,
} from "../../src/mcp-conformance/raw-http.js";

const JSON_HEADERS = { "content-type": "application/json" };

function jsonAnswer(
  message: unknown,
  headers: Record<string, string> = {},
  statusCode = 200,
) {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...headers },
    bodyText: JSON.stringify(message),
  };
}

function initializeResult(protocolVersion?: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      capabilities: {},
      serverInfo: { name: "fixture", version: "1.0.0" },
    },
  };
}

const RPC_ERROR = {
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32603, message: "initialize handler threw" },
};

describe("planHandshakeFollowUp: initialization succeeded", () => {
  it("finishes the handshake on the session the server opened", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-11-25"), {
          "mcp-session-id": "session-1",
        }),
        "2025-11-25",
      ),
    ).toEqual({ kind: "complete", sessionId: "session-1" });
  });

  it("finishes the handshake when the server gives no session id", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-06-18")),
        "2025-06-18",
      ),
    ).toEqual({ kind: "complete" });
  });

  it.each(["text/event-stream", "Text/Event-Stream; charset=utf-8"])(
    "reads an initialize result that arrives as an SSE frame (%s)",
    (contentType) => {
      const frame = `event: message\ndata: ${JSON.stringify(
        initializeResult("2025-03-26"),
      )}\n\n`;
      expect(
        planHandshakeFollowUp(
          {
            statusCode: 200,
            headers: {
              "content-type": contentType,
              "mcp-session-id": "sse-session",
            },
            bodyText: frame,
          },
          "2025-03-26",
        ),
      ).toEqual({ kind: "complete", sessionId: "sse-session" });
    },
  );

  it.each([
    ["names no version", undefined],
    ["names a version that is not a string", 20251125],
  ])("finishes the handshake when the result %s", (_label, version) => {
    // Nothing says the server moved to another version, so the run goes on
    // with the one it asked for.
    expect(
      planHandshakeFollowUp(jsonAnswer(initializeResult(version)), "2025-11-25"),
    ).toEqual({ kind: "complete" });
  });
});

describe("planHandshakeFollowUp: the server answered another version", () => {
  it.each([
    ["an older version MCPJam supports", "2025-06-18"],
    ["the stateless revision, which has no initialize lifecycle", "2026-07-28"],
    ["a version MCPJam does not know", "2099-01-01"],
    ["the requested version with a line break after it", "2025-11-25\n"],
  ])("disconnects on %s", (_label, answeredVersion) => {
    // A run is about one version. MCPJam's pinned client refuses any other
    // answer, and so do the other hand-built probes.
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult(answeredVersion), {
          "mcp-session-id": "other-session",
        }),
        "2025-11-25",
      ),
    ).toEqual({
      kind: "disconnect",
      sessionId: "other-session",
      answeredVersion,
    });
  });

  it("disconnects with no session to close when the server gave none", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-06-18")),
        "2025-11-25",
      ),
    ).toEqual({ kind: "disconnect", answeredVersion: "2025-06-18" });
  });
});

describe("planHandshakeFollowUp: initialization did not succeed", () => {
  it("sends nothing after a status outside 2xx", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-11-25"), {}, 403),
        "2025-11-25",
      ),
    ).toEqual({ kind: "none", reason: "refused" });
  });

  it("opens no session on a refusal, even one that carries a session id", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(RPC_ERROR, { "mcp-session-id": "refused-session" }, 403),
        "2025-11-25",
      ),
    ).toEqual({ kind: "none", reason: "refused" });
  });

  it("names a 2xx JSON-RPC error for what it is, not a refusal", () => {
    expect(planHandshakeFollowUp(jsonAnswer(RPC_ERROR), "2025-11-25")).toEqual({
      kind: "none",
      reason: "error-answer",
    });
  });

  it("keeps the session id of a 2xx JSON-RPC error, so it can be closed", () => {
    // The official TypeScript SDK hands out the session id before the
    // server's initialize handler runs.
    expect(
      planHandshakeFollowUp(
        jsonAnswer(RPC_ERROR, { "mcp-session-id": "errored-session" }),
        "2025-11-25",
      ),
    ).toEqual({
      kind: "none",
      reason: "error-answer",
      sessionId: "errored-session",
    });
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "<html>ok</html>"],
    ["a JSON body with no result", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
    ["a JSON array", JSON.stringify([initializeResult("2025-11-25")])],
    // What the shared readers say about these, so the probe says the same.
    ["an error that is not a JSON-RPC error", JSON.stringify({ error: {} })],
    ["a result that is not an object", JSON.stringify({ result: "ok" })],
  ])("sends no notification after a 2xx answer with %s", (_label, bodyText) => {
    expect(
      planHandshakeFollowUp(
        {
          statusCode: 200,
          headers: { ...JSON_HEADERS, "mcp-session-id": "unconfirmed" },
          bodyText,
        },
        "2025-11-25",
      ),
    ).toEqual({ kind: "none", reason: "no-result", sessionId: "unconfirmed" });
  });
});

describe("followUpTimeoutMs", () => {
  it.each([
    [30_000, 3_000],
    [10_000, 3_000],
    [3_000, 3_000],
    [1_000, 1_000],
  ])("caps a %i ms check timeout at %i ms", (checkTimeout, expected) => {
    expect(followUpTimeoutMs(checkTimeout)).toBe(expected);
  });
});

describe("decodeResponseBody: the one body decoder", () => {
  const frame = `event: message\ndata: ${JSON.stringify(
    initializeResult("2025-11-25"),
  )}\n\n`;

  it.each([
    "text/event-stream",
    "text/event-stream; charset=utf-8",
    "Text/Event-Stream",
    "TEXT/EVENT-STREAM",
  ])("reads %s as an event stream", (contentType) => {
    expect(isEventStream(contentType)).toBe(true);
    const decoded = decodeResponseBody(contentType, frame);
    expect(decoded.json).toBeUndefined();
    expect(jsonRpcResult(decoded)).toMatchObject({
      protocolVersion: "2025-11-25",
    });
  });

  it.each(["application/json", "", "text/plain"])(
    "reads %j as one JSON document",
    (contentType) => {
      expect(isEventStream(contentType)).toBe(false);
      const decoded = decodeResponseBody(contentType, JSON.stringify(RPC_ERROR));
      expect(decoded.sse).toBeUndefined();
      expect(jsonRpcError(decoded)).toMatchObject({ code: -32603 });
    },
  );

  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "<html>ok</html>"],
  ])("decodes %s to nothing", (_label, bodyText) => {
    expect(decodeResponseBody("application/json", bodyText)).toEqual({});
  });
});
