/**
 * The shared tool-result message shape.
 *
 * This is the contract two engines have to agree on: the emulated engine
 * builds these as it executes tools, and the harness engine projects them from
 * evidence rows after the fact. If they disagree by a field, the same tool
 * result grades differently depending on which engine produced it — which is
 * precisely the comparison harness/emulated parity exists to enable.
 */
import { describe, expect, test } from "vitest";
import {
  buildMcpToolErrorResultMessage,
  buildMcpToolResultMessage,
  jsonRpcErrorMessageText,
  mcpToolErrorOutput,
} from "../mcp-tool-result-message";

const output = { type: "json", value: { ok: true } } as never;

describe("a call that returned", () => {
  test("carries the model-visible output, the raw result, and the origin", () => {
    const message = buildMcpToolResultMessage({
      toolCallId: "call_1",
      toolName: "search",
      serverId: "server-1",
      output,
      rawResult: {
        content: [{ type: "text", text: "hi" }],
        structuredContent: { rows: 2 },
        _meta: { "mcpjam/origin": "server" },
      },
      includeRawResult: true,
    });

    expect(message.role).toBe("tool");
    expect(message.content).toHaveLength(1);
    const part = message.content[0];
    expect(part.type).toBe("tool-result");
    expect(part.toolCallId).toBe("call_1");
    expect(part.toolName).toBe("search");
    expect(part.output).toBe(output);
    // `_meta` and `structuredContent` survive on the raw result even though
    // the model-visible output may have had them scrubbed — widget hydration
    // and evidence-graded assertions read the second, not the first.
    expect(part.result).toMatchObject({
      structuredContent: { rows: 2 },
      _meta: { "mcpjam/origin": "server" },
    });
    expect(part.serverId).toBe("server-1");
    expect(part.providerOptions).toMatchObject({
      mcpjam: { serverId: "server-1" },
    });
  });

  test("withholds the raw result when the caller says not to attach it", () => {
    // The MCP-App path passes the result but only publishes it for tools that
    // opt in; "attach whatever was passed" would leak it for the rest.
    const part = buildMcpToolResultMessage({
      toolCallId: "call_1",
      toolName: "search",
      serverId: "server-1",
      output,
      rawResult: { content: [] },
      includeRawResult: false,
    }).content[0];

    expect(part).not.toHaveProperty("result");
  });

  test("omits provider options when there is no server to attribute", () => {
    const part = buildMcpToolResultMessage({
      toolCallId: "call_1",
      toolName: "search",
      output,
    }).content[0];

    expect(part).not.toHaveProperty("providerOptions");
    expect(part.serverId).toBeUndefined();
  });

  test("an isError result travels the SUCCESS shape", () => {
    // `isError: true` is a domain error the model is meant to read, not a
    // transport failure. Giving it the error shape would strip the result the
    // model actually saw and make it unassertable.
    const part = buildMcpToolResultMessage({
      toolCallId: "call_1",
      toolName: "search",
      serverId: "server-1",
      output,
      rawResult: { content: [{ type: "text", text: "no" }], isError: true },
      includeRawResult: true,
    }).content[0];

    expect(part.result).toMatchObject({ isError: true });
    expect(part.output).toBe(output);
  });
});

describe("a call that failed to return", () => {
  test("carries no result and no origin", () => {
    const part = buildMcpToolErrorResultMessage({
      toolCallId: "call_1",
      toolName: "search",
      output: mcpToolErrorOutput("upstream exploded"),
    }).content[0];

    expect(part.output).toEqual({
      type: "error-text",
      value: "upstream exploded",
    });
    // Attaching an origin to a call that never reached its server would make
    // a failure read as a reply from that server.
    expect(part).not.toHaveProperty("result");
    expect(part).not.toHaveProperty("serverId");
    expect(part).not.toHaveProperty("providerOptions");
  });
});

describe("jsonRpcErrorMessageText", () => {
  test("reads a thrown Error, a JSON-RPC envelope, and a bare string", () => {
    expect(jsonRpcErrorMessageText(new Error("boom"))).toBe("boom");
    expect(
      jsonRpcErrorMessageText({ error: { code: -32000, message: "nope" } }),
    ).toBe("nope");
    expect(jsonRpcErrorMessageText("plain")).toBe("plain");
  });

  test("never folds the error CODE into the text", () => {
    // The code rides the span's `mcpErrorCode`, where a reader can match on
    // it. Concatenating it here would make every assertion about an error
    // message depend on a number recorded elsewhere.
    expect(
      jsonRpcErrorMessageText({ code: -32601, message: "no such tool" }),
    ).toBe("no such tool");
  });

  test("falls back rather than emitting an empty message", () => {
    for (const value of [null, undefined, {}, { message: "" }, 42]) {
      expect(jsonRpcErrorMessageText(value)).toBe("Tool call failed");
    }
  });
});
