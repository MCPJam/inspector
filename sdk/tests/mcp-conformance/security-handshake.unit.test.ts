/**
 * What follows the `initialize` a host-header probe sends by hand.
 *
 * "After successful initialization, the client MUST send an `initialized`
 * notification." These pin the decision for each kind of answer: finish the
 * handshake, disconnect, or send nothing.
 */

import { planHandshakeFollowUp } from "../../src/mcp-conformance/checks/security-handshake.js";

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

function initializeResult(protocolVersion?: string) {
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

describe("planHandshakeFollowUp", () => {
  it("finishes the handshake on the session the server opened", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-11-25"), {
          "mcp-session-id": "session-1",
        }),
        "2025-11-25",
      ),
    ).toEqual({
      kind: "complete",
      sessionId: "session-1",
      protocolVersion: "2025-11-25",
    });
  });

  it("finishes the handshake when the server gives no session id", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-06-18")),
        "2025-06-18",
      ),
    ).toEqual({ kind: "complete", protocolVersion: "2025-06-18" });
  });

  it("reads an initialize result that arrives as an SSE frame", () => {
    const frame = `event: message\ndata: ${JSON.stringify(
      initializeResult("2025-03-26"),
    )}\n\n`;
    expect(
      planHandshakeFollowUp(
        {
          statusCode: 200,
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "sse-session",
          },
          bodyText: frame,
        },
        "2025-03-26",
      ),
    ).toEqual({
      kind: "complete",
      sessionId: "sse-session",
      protocolVersion: "2025-03-26",
    });
  });

  it("uses the version the server answered with when MCPJam supports it", () => {
    // The server does not support the version it was asked for and offers an
    // older one. A client that supports that one goes on with it.
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-06-18")),
        "2025-11-25",
      ),
    ).toEqual({ kind: "complete", protocolVersion: "2025-06-18" });
  });

  it("falls back to the requested version when the result names none", () => {
    expect(
      planHandshakeFollowUp(jsonAnswer(initializeResult()), "2025-11-25"),
    ).toEqual({ kind: "complete", protocolVersion: "2025-11-25" });
  });

  it("disconnects when the server answers a version MCPJam does not support", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2099-01-01"), {
          "mcp-session-id": "future-session",
        }),
        "2025-11-25",
      ),
    ).toEqual({
      kind: "disconnect",
      sessionId: "future-session",
      answeredVersion: "2099-01-01",
    });
  });

  it("sends nothing after a JSON-RPC error, even on HTTP 200", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Unsupported protocol version" },
        }),
        "2025-11-25",
      ),
    ).toEqual({ kind: "none", reason: "refused" });
  });

  it("sends nothing after a status outside 2xx", () => {
    expect(
      planHandshakeFollowUp(
        jsonAnswer(initializeResult("2025-11-25"), {}, 403),
        "2025-11-25",
      ),
    ).toEqual({ kind: "none", reason: "refused" });
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "<html>ok</html>"],
    ["a JSON body with no result", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
    ["a JSON array", JSON.stringify([initializeResult("2025-11-25")])],
  ])("sends nothing after a 2xx answer with %s", (_label, bodyText) => {
    expect(
      planHandshakeFollowUp(
        { statusCode: 200, headers: JSON_HEADERS, bodyText },
        "2025-11-25",
      ),
    ).toEqual({ kind: "none", reason: "no-result" });
  });
});
