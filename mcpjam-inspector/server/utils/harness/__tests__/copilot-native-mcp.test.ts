/**
 * The Copilot bridge's native MCP pieces, driven with the event and hook
 * shapes CLI 1.0.92 / SDK 1.0.11 produced against a local MCP server.
 */
import { describe, expect, it } from "vitest";
import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import {
  COPILOT_CORRELATION_KEY,
  createNativeMcpTranslator,
  nativeMcpPermission,
  nativeMcpSessionConfig,
  parseNativeMcpServers,
  stampNativeMcpCall,
} from "../copilot-cli/bridge/native-mcp.js";

const SERVERS = parseNativeMcpServers({
  weather: {
    type: "http",
    url: "https://forwarder.example/mcp/weather?native=1",
    headers: { Connection: "close", "X-MCPJam-Forwarding-Context": "sealed" },
    timeout: 240_000,
  },
});

const event = (type: string, data: Record<string, unknown>) =>
  ({ id: "e", parentId: null, timestamp: "t", type, data }) as SessionEvent;

const start = (overrides: Record<string, unknown> = {}) =>
  event("tool.execution_start", {
    toolCallId: "call_1",
    toolName: "weather-record_write",
    arguments: { note: "one" },
    turnId: "0",
    mcpServerName: "weather",
    mcpConfigServerName: "weather",
    mcpToolName: "record_write",
    ...overrides,
  });

describe("forwarded server configuration", () => {
  it("accepts the forwarder's entries and rejects anything else", () => {
    expect(parseNativeMcpServers(undefined)).toEqual({});
    expect(SERVERS.weather.timeout).toBe(240_000);
    for (const entry of [
      { type: "sse", url: "https://a.example" },
      { type: "http", url: "not a url" },
      { type: "http", url: "https://a.example", command: "sh" },
      { type: "http", url: "https://a.example", headers: { A: 1 } },
      { type: "http", url: "https://a.example", timeout: -1 },
    ])
      expect(() => parseNativeMcpServers({ bad: entry })).toThrow(
        "Invalid forwarded MCP server bad.",
      );
    expect(() => parseNativeMcpServers([])).toThrow();
  });

  it("exposes MCP tools only when servers are forwarded", () => {
    expect(nativeMcpSessionConfig({})).toEqual({ mcpToolPatterns: [] });
    expect(nativeMcpSessionConfig(SERVERS)).toEqual({
      mcpServers: { weather: { ...SERVERS.weather, tools: ["*"] } },
      mcpToolPatterns: ["mcp:*"],
    });
  });
});

describe("the CLI's own permission prompt", () => {
  const mcp = (overrides: Partial<PermissionRequest> = {}) =>
    ({
      kind: "mcp",
      toolCallId: "call_1",
      serverName: "weather",
      toolName: "weather-record_write",
      toolTitle: "record_write",
      args: { note: "one" },
      readOnly: false,
      ...overrides,
    }) as PermissionRequest;

  it("lets a forwarded call through to the forwarder's gate", () => {
    expect(nativeMcpPermission(mcp(), SERVERS)).toEqual({
      kind: "approve-once",
    });
  });

  it("denies other servers, uncorrelated calls and every other kind", () => {
    const denied = { kind: "denied-interactively-by-user" };
    expect(nativeMcpPermission(mcp({ serverName: "other" }), SERVERS)).toEqual(
      denied,
    );
    expect(
      nativeMcpPermission(mcp({ toolCallId: undefined }), SERVERS),
    ).toEqual(denied);
    expect(
      nativeMcpPermission(
        { kind: "shell", fullCommandText: "rm -rf /" } as PermissionRequest,
        SERVERS,
      ),
    ).toEqual(denied);
    expect(nativeMcpPermission(mcp(), {})).toEqual(denied);
  });
});

describe("correlation stamp", () => {
  const input = {
    toolCallId: "call_1",
    serverName: "weather",
    toolName: "record_write",
    arguments: {},
    sessionId: "s",
    timestamp: 0,
    workingDirectory: "/w",
  };

  it("adds MCPJam's key to the request metadata the CLI sends", () => {
    expect(stampNativeMcpCall({ ...input, _meta: { trace: "kept" } })).toEqual({
      metaToUse: { trace: "kept", [COPILOT_CORRELATION_KEY]: "call_1" },
    });
  });

  it("leaves the request alone without a tool call id", () => {
    expect(stampNativeMcpCall({ ...input, toolCallId: undefined })).toBe(
      undefined,
    );
  });
});

describe("tool parts", () => {
  const translate = () => {
    const parts: Record<string, unknown>[] = [];
    return {
      parts,
      translate: createNativeMcpTranslator(SERVERS, (p) => parts.push(p)),
    };
  };

  it("names a forwarded call as host attribution parses it and closes it once", () => {
    const { parts, translate: next } = translate();
    expect(next(start())).toBe(true);
    expect(
      next(
        event("tool.execution_complete", {
          toolCallId: "call_1",
          success: true,
          result: {
            content: "Recorded one (#1)\n\n{...}",
            contents: [{ type: "text", text: "Recorded one (#1)" }],
            structuredContent: { writes: 1 },
          },
        }),
      ),
    ).toBe(true);
    expect(
      next(
        event("tool.execution_complete", {
          toolCallId: "call_1",
          success: true,
        }),
      ),
    ).toBe(false);
    expect(parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "mcp__weather__record_write",
        input: JSON.stringify({ note: "one" }),
        providerExecuted: true,
        dynamic: true,
      },
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "mcp__weather__record_write",
        result: {
          content: [{ type: "text", text: "Recorded one (#1)" }],
          structuredContent: { writes: 1 },
        },
      },
    ]);
  });

  it("reports a timed-out call as an error", () => {
    const { parts, translate: next } = translate();
    next(start({ toolCallId: "call_7" }));
    next(
      event("tool.execution_complete", {
        toolCallId: "call_7",
        success: false,
        error: {
          message:
            "MCP server 'weather': McpError: MCP error -32001: Request timed out",
          code: "failure",
        },
      }),
    );
    expect(parts[1]).toEqual({
      type: "tool-result",
      toolCallId: "call_7",
      toolName: "mcp__weather__record_write",
      result: {
        content: [
          {
            type: "text",
            text: "MCP server 'weather': McpError: MCP error -32001: Request timed out",
          },
        ],
        isError: true,
      },
      isError: true,
    });
  });

  it("ignores host tools and servers this turn did not forward", () => {
    const { parts, translate: next } = translate();
    expect(
      next(start({ mcpServerName: undefined, mcpToolName: undefined })),
    ).toBe(false);
    expect(next(start({ mcpServerName: "other" }))).toBe(false);
    expect(next(event("assistant.message_delta", { deltaContent: "hi" }))).toBe(
      false,
    );
    expect(parts).toEqual([]);
  });
});
