import { describe, expect, it } from "vitest";
import { z } from "zod";
import { harnessV1StreamPartSchema } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessV1, HarnessV1NetworkSandboxSession, HarnessV1PromptControl, HarnessV1StreamPart } from "@ai-sdk/harness";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const boundary: HarnessV1StreamPart = { type: "finish-step", finishReason: { unified: "tool-calls", raw: undefined }, usage };
const sandbox: HarnessV1NetworkSandboxSession = {
  id: "sandbox", defaultWorkingDirectory: "/work", description: "fixture", ports: [],
  readFile: async () => null, readBinaryFile: async () => null, readTextFile: async () => null,
  writeFile: async () => {}, writeBinaryFile: async () => {}, writeTextFile: async () => {},
  run: async () => ({ exitCode: 0, stdout: "/work\n", stderr: "" }),
  spawn: async () => { throw new Error("No processes in this fixture"); },
  getPortEndpoint: async () => ({ url: "http://localhost" }), getPortUrl: async () => "http://localhost",
  stop: async () => {}, destroy: async () => {}, restricted: () => sandbox,
};
async function collect(stream: AsyncIterable<{ type: string }>) {
  const parts: Array<{ type: string }> = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("Cursor approved host relay in real HarnessAgent", () => {
  it.each([false, true])("executes once without a second approval, duplicate=%s", async (duplicate) => {
    let executions = 0;
    const executedInputs: unknown[] = [];
    const harness: HarnessV1 = {
      specificationVersion: "harness-v1", harnessId: "cursor", supportsBuiltinToolApprovals: true,
      builtinTools: { native_mcp: { inputSchema: z.object({ text: z.string() }) } },
      doStart: async (start) => {
        const begin = async ({ emit: emitRaw }: { emit(part: HarnessV1StreamPart): void }): Promise<HarnessV1PromptControl> => {
          const emit = (part: HarnessV1StreamPart) => emitRaw(harnessV1StreamPartSchema.parse(JSON.parse(JSON.stringify(part))));
          let finish!: () => void;
          const done = new Promise<void>((resolve) => { finish = resolve; });
          if (!start.continueFrom) queueMicrotask(() => {
            emit({ type: "tool-call", toolCallId: "native-1", toolName: "native_mcp", input: '{"providerIdentifier":"host-tools","toolName":"echo","args":{"text":"one"}}', providerExecuted: true });
            emit({ type: "tool-approval-request", approvalId: "allow-1", toolCallId: "native-1" });
            emit(boundary);
          });
          return {
            done,
            submitToolApproval: async ({ approved }) => {
              if (!approved) throw new Error("Expected allow in this scenario");
              queueMicrotask(() => {
                emit({ type: "tool-call", toolCallId: "native-1", toolName: "echo", input: '{"text":"one"}', providerExecuted: false,
                  providerMetadata: { mcpjam: { approvedHostToolCallId: "native-1" } } });
                if (duplicate) emit({ type: "tool-call", toolCallId: "native-1", toolName: "echo", input: '{"text":"one"}', providerExecuted: false, providerMetadata: { mcpjam: { approvedHostToolCallId: "native-1" } } });
                emit(boundary);
              });
            },
            submitToolResult: async ({ toolCallId, output }) => {
              emit({ type: "tool-result", toolCallId, toolName: "echo", result: output });
              emit({ type: "finish-step", finishReason: { unified: "stop", raw: undefined }, usage });
              emit({ type: "finish", finishReason: { unified: "stop", raw: undefined }, totalUsage: usage });
              finish();
            },
          };
        };
        const state = () => ({ type: "resume-session" as const, harnessId: "cursor", specificationVersion: "harness-v1" as const, data: {} });
        return {
          sessionId: start.sessionId, isResume: !!start.continueFrom,
          doPromptTurn: begin, doContinueTurn: begin, doCompact: async () => {},
          doSuspendTurn: async () => ({ ...state(), type: "continue-turn" as const }),
          doDetach: async () => state(), doStop: async () => state(), doDestroy: async () => {},
        };
      },
    };
    const agent = new HarnessAgent({ harness, permissionMode: "allow-reads", tools: {
      echo: { inputSchema: z.object({ text: z.string() }), execute: async (input) => { const { text } = input; executedInputs.push(input); executions++; await new Promise<void>((resolve) => setImmediate(resolve)); return text; } },
    } });
    const first = await agent.createSession({ sessionId: "session", sandboxSession: sandbox });
    const firstStream = await agent.stream({ session: first, prompt: "echo" });
    expect((await collect(firstStream.fullStream)).filter(p => p.type === "tool-approval-request")).toHaveLength(1);
    const paused = await first.suspendTurn();
    const resumed = await agent.createSession({ sessionId: "session", sandboxSession: sandbox, continueFrom: paused });
    const next = await agent.continueStream({ session: resumed, toolApprovalContinuations: [{ approvalId: "allow-1", approved: true }] });
    const parts = await collect(next.fullStream);
    expect(executions).toBe(1);
    expect(executedInputs).toEqual([{ text: "one" }]);
    expect(parts.filter(p => p.type === "tool-approval-request")).toHaveLength(0);
    expect(parts.some(p => p.type === "tool-result")).toBe(true);
  }, 5000);
});
