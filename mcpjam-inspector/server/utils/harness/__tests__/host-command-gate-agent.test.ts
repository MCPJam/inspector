/**
 * The gate's entry in `toolApproval`, read by the real `HarnessAgent`: it is
 * consulted at each host tool call, so a server skill loaded between two
 * calls makes the second one ask. A snapshot of the map at construction
 * would let the second command run unasked.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { harnessV1StreamPartSchema } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type {
  HarnessV1,
  HarnessV1NetworkSandboxSession,
  HarnessV1PromptControl,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";
import {
  hostToolApproval,
  withHostCommandGate,
} from "../server-skill-command-gate.js";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const stepEnd: HarnessV1StreamPart = {
  type: "finish-step",
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
};
const sandbox = {
  id: "sandbox",
  defaultWorkingDirectory: "/work",
  description: "fixture",
  ports: [],
  readFile: async () => null,
  readBinaryFile: async () => null,
  readTextFile: async () => null,
  writeFile: async () => {},
  writeBinaryFile: async () => {},
  writeTextFile: async () => {},
  run: async () => ({ exitCode: 0, stdout: "/work\n", stderr: "" }),
  spawn: async () => {
    throw new Error("No processes in this fixture");
  },
  getPortEndpoint: async () => ({ url: "http://localhost" }),
  getPortUrl: async () => "http://localhost",
  stop: async () => {},
  destroy: async () => {},
  restricted: () => sandbox,
} as HarnessV1NetworkSandboxSession;

/** A runtime that calls host `bash` twice; a skill loads after the first. */
function runtimeLoadingASkill(onFirstResult: () => void): HarnessV1 {
  const callBash = (emit: (part: HarnessV1StreamPart) => void, id: string) => {
    emit({
      type: "tool-call",
      toolCallId: id,
      toolName: "bash",
      input: JSON.stringify({ command: id }),
      providerExecuted: false,
    });
    emit(stepEnd);
  };
  const state = () => ({
    type: "resume-session" as const,
    harnessId: "codex",
    specificationVersion: "harness-v1" as const,
    data: {},
  });
  return {
    specificationVersion: "harness-v1",
    harnessId: "codex",
    supportsBuiltinToolApprovals: true,
    builtinTools: {},
    doStart: async (start) => {
      const begin = async (options: {
        emit(part: HarnessV1StreamPart): void;
      }): Promise<HarnessV1PromptControl> => {
        const emit = (part: HarnessV1StreamPart) =>
          options.emit(harnessV1StreamPartSchema.parse(part));
        queueMicrotask(() => callBash(emit, "first"));
        return {
          done: new Promise<void>(() => {}),
          submitToolApproval: async () => {},
          submitToolResult: async ({ toolCallId, output }) => {
            emit({
              type: "tool-result",
              toolCallId,
              toolName: "bash",
              result: output,
            });
            if (toolCallId !== "first") return;
            onFirstResult();
            queueMicrotask(() => callBash(emit, "second"));
          },
        };
      };
      return {
        sessionId: start.sessionId,
        isResume: false,
        doPromptTurn: begin,
        doContinueTurn: begin,
        doCompact: async () => {},
        doSuspendTurn: async () => ({
          ...state(),
          type: "continue-turn" as const,
        }),
        doDetach: async () => state(),
        doStop: async () => state(),
        doDestroy: async () => {},
      };
    },
  };
}

describe("the gate's toolApproval entry in HarnessAgent", () => {
  it("asks a member about the command after a server skill loads mid-turn", async () => {
    let inUse = false;
    const execute = vi.fn(async ({ command }: { command: string }) => command);
    const gate = {
      inUse: () => inUse,
      switchOn: false,
      answerer: "member" as const,
    };
    const tools = withHostCommandGate(
      { bash: { inputSchema: z.object({ command: z.string() }), execute } },
      gate,
    );
    const agent = new HarnessAgent({
      harness: runtimeLoadingASkill(() => {
        inUse = true;
      }),
      permissionMode: "allow-edits",
      tools,
      toolApproval: hostToolApproval([], tools, gate),
    });
    const session = await agent.createSession({
      sessionId: "session",
      sandboxSession: sandbox,
    });
    const stream = await agent.stream({ session, prompt: "run it" });
    const parts: Array<{ type: string; toolCall?: { toolCallId?: string } }> =
      [];
    for await (const part of stream.fullStream) parts.push(part);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual({ command: "first" });
    expect(
      parts
        .filter((part) => part.type === "tool-approval-request")
        .map((part) => part.toolCall?.toolCallId),
    ).toEqual(["second"]);
  }, 5000);
});
