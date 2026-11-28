/**
 * The Copilot bridge's native MCP pieces, driven with the event and hook
 * shapes CLI 1.0.92 / SDK 1.0.11 produced against MCPJam's per-server proxy
 * and a forwarded server.
 */
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import {
  COPILOT_CORRELATION_KEY,
  createNativeMcpCalls,
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

describe("delivered server configuration", () => {
  it("accepts proxy and forwarder entries and rejects anything else", () => {
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
        "Invalid MCP server bad.",
      );
    expect(() => parseNativeMcpServers([])).toThrow();
  });

  it("exposes MCP tools only when servers are delivered", () => {
    expect(nativeMcpSessionConfig({})).toEqual({ mcpToolPatterns: [] });
    expect(nativeMcpSessionConfig(SERVERS)).toEqual({
      mcpServers: { weather: { ...SERVERS.weather, tools: ["*"] } },
      mcpToolPatterns: ["mcp:*"],
    });
  });
});

describe("the CLI's own permission prompt", () => {
  // As measured: the model-facing name, after `tool.execution_start`.
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
  const calls = (ask?: (approvalId: string) => Promise<{ approved: boolean; reason?: string }>) => {
    const parts: Record<string, unknown>[] = [];
    return { parts, calls: createNativeMcpCalls({ servers: SERVERS, emit: (p) => parts.push(p), ...(ask ? { ask } : {}) }) };
  };

  it("lets a call through unasked on a turn that approves everything", async () => {
    const { parts, calls: native } = calls();
    await expect(native.permission(mcp())).resolves.toEqual({ kind: "approve-once" });
    expect(parts).toEqual([]);
  });

  it("puts the call to the host, closing the step, and holds it until the answer", async () => {
    let answer!: (decision: { approved: boolean }) => void;
    const ask = vi.fn(() => new Promise<{ approved: boolean }>((resolve) => { answer = resolve; }));
    const { parts, calls: native } = calls(ask);
    native.translate(start());
    const pending = native.permission(mcp());
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const approvalId = ask.mock.calls[0]![0];
    expect(approvalId).toMatch(/^copilot-approval-/);
    expect(parts.map((part) => part.type)).toEqual(["tool-call", "tool-approval-request", "finish-step"]);
    expect(parts[1]).toEqual({ type: "tool-approval-request", approvalId, toolCallId: "call_1" });
    answer({ approved: true });
    await expect(pending).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
  });

  it("tells the CLI a denial with feedback, so the model hears it and the turn goes on", async () => {
    const { calls: native } = calls(async () => ({ approved: false }));
    await expect(native.permission(mcp())).resolves.toEqual({ kind: "reject", feedback: "Denied" });
    const { calls: withReason } = calls(async () => ({ approved: false, reason: "Not this order." }));
    await expect(withReason.permission(mcp())).resolves.toEqual({ kind: "reject", feedback: "Not this order." });
  });

  it("names the call once, whichever of the prompt and the execution start comes first", async () => {
    const { parts, calls: native } = calls(async () => ({ approved: true }));
    await native.permission(mcp());
    native.translate(start());
    const toolCalls = parts.filter((part) => part.type === "tool-call");
    expect(toolCalls).toEqual([expect.objectContaining({ toolName: "mcp__weather__record_write", toolCallId: "call_1" })]);
  });

  it("asks with a fresh approval id every time", async () => {
    const ask = vi.fn(async () => ({ approved: true }));
    const { calls: native } = calls(ask);
    await native.permission(mcp());
    await native.permission(mcp({ toolCallId: "call_2" }));
    expect(new Set(ask.mock.calls.map(([id]) => id)).size).toBe(2);
  });

  it("denies other servers, uncorrelated calls and every other kind, unasked", async () => {
    const ask = vi.fn(async () => ({ approved: true }));
    const { calls: native } = calls(ask);
    for (const request of [
      mcp({ serverName: "other" }),
      mcp({ toolCallId: undefined }),
      { kind: "shell", fullCommandText: "rm -rf /" } as PermissionRequest,
    ])
      await expect(native.permission(request)).resolves.toEqual({ kind: "reject" });
    const { calls: none } = calls();
    const empty = createNativeMcpCalls({ servers: {}, emit: () => {} });
    await expect(empty.permission(mcp())).resolves.toEqual({ kind: "reject" });
    await expect(none.permission(mcp({ serverName: "other" }))).resolves.toEqual({ kind: "reject" });
    expect(ask).not.toHaveBeenCalled();
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
    const createdCalls = createNativeMcpCalls({ servers: SERVERS, emit: (p) => parts.push(p) });
    return {
      parts,
      translate: (event: SessionEvent) =>
        createdCalls.translate(event),
    };
  };

  it("names a call as host attribution parses it and closes it once", () => {
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

  it("ignores host tools and servers this turn did not deliver", () => {
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
