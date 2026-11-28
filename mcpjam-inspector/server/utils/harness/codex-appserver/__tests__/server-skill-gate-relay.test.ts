/**
 * MCPJam's server-skill tools on Codex reach the model through the `mcpjam`
 * relay MCP server, and the command gate holds Codex's own commands. These
 * pin that the gate's mode makes Codex ask before commands, that the only
 * requests Codex raises are its commands and patches, and that a relayed call
 * (a skill tool) never becomes a request the gate could refuse.
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeTurn } from "@ai-sdk/harness/bridge";
import { toCodexPermissions } from "../bridge/index.js";
import { createApprovalController } from "../bridge/approval-controller.js";
import { renderCodexConfigToml } from "../bridge/codex-home.js";
import { createStreamTranslator } from "../bridge/stream-translator.js";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";
import {
  COMMAND_GATE_PERMISSION_MODE,
  isCommandRequest,
} from "../../server-skill-command-gate.js";

function controllerTurn() {
  const parts: BridgeEvent[] = [];
  const turn = {
    emit: (part: BridgeEvent) => parts.push(part),
    emitWarning: vi.fn(),
    emitError: vi.fn(),
    bridgeLog: vi.fn(),
    requestToolApproval: vi.fn(async () => ({ approved: true })),
    requestToolResult: vi.fn(),
    abortSignal: new AbortController().signal,
    firstTurn: true,
    experimental_userMessages: undefined,
  } as unknown as BridgeTurn;
  const translator = createStreamTranslator({
    emit: (part) => parts.push(part),
    emitWarning: () => {},
    emitError: () => {},
    relayServerName: RELAY_MCP_SERVER_NAME,
    emitRaw: false,
  });
  return { controller: createApprovalController({ turn, translator }), parts };
}

/** The call each request asks about, as the gate reads it. */
function requestedCalls(parts: BridgeEvent[]) {
  const calls = new Map(
    parts.flatMap((part) =>
      part.type === "tool-call"
        ? [
            [
              part.toolCallId,
              { name: part.toolName, nativeName: part.nativeName, input: {} },
            ] as const,
          ]
        : [],
    ),
  );
  return parts.flatMap((part) =>
    part.type === "tool-approval-request" ? [calls.get(part.toolCallId)] : [],
  );
}

describe("Codex under the server-skill gate", () => {
  it("asks before every command in the gate's mode", () => {
    expect(toCodexPermissions(COMMAND_GATE_PERMISSION_MODE)).toMatchObject({
      approvalPolicy: "untrusted",
    });
  });

  it("raises requests for its commands, which the gate holds, and its patches, which it lets through", async () => {
    const { controller, parts } = controllerTurn();
    await controller.handle({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t",
        turnId: "u",
        itemId: "cmd",
        startedAtMs: 1,
        command: "ls",
      },
    });
    await controller.handle({
      id: 2,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t", turnId: "u", itemId: "patch", startedAtMs: 1 },
    });
    expect(requestedCalls(parts).map(isCommandRequest)).toEqual([true, false]);
  });

  it("never turns a relayed call into a request: the relay is told to ask before none", async () => {
    const toml = renderCodexConfigToml({
      codexHome: "/h",
      baseUrl: "https://proxy.example/v1",
      apiKeyEnvVar: "KEY",
      hostToolsEntrypoint: "/b/host-tools-mcp.mjs",
      relayUrl: "http://127.0.0.1:1",
      relayCredential: "c",
    });
    const relay = toml.split(`[mcp_servers.${RELAY_MCP_SERVER_NAME}]`)[1] ?? "";
    expect(relay.split("\n[")[0]).toContain(
      'default_tools_approval_mode = "approve"',
    );
    // Without that line Codex asks with an elicitation, which the bridge
    // declines without a request: a skill tool call would fail, not wait.
    const { controller, parts } = controllerTurn();
    expect(
      await controller.handle({
        id: 3,
        method: "mcpServer/elicitation/request",
        params: { threadId: "t", serverName: RELAY_MCP_SERVER_NAME },
      }),
    ).toEqual({ action: "decline", content: null });
    expect(
      parts.filter((part) => part.type === "tool-approval-request"),
    ).toEqual([]);
  });
});
