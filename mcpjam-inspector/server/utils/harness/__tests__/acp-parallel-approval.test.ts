import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { SandboxChannel } from "@ai-sdk/harness/utils";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type {
  HarnessV1,
  HarnessV1NetworkSandboxSession,
  HarnessV1StreamPart,
  HarnessV1PromptControl,
} from "@ai-sdk/harness";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const boundary: HarnessV1StreamPart = {
  type: "finish-step",
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
};
const calls: HarnessV1StreamPart[] = [1, 2].flatMap((id) => [
  {
    type: "tool-call",
    toolCallId: `call-${id}`,
    toolName: "fast_write",
    input: '{"key":"same","value":"1"}',
    providerExecuted: true,
  },
  {
    type: "tool-approval-request",
    approvalId: `approval-${id}`,
    toolCallId: `call-${id}`,
  },
  boundary,
]);
const sandbox: HarnessV1NetworkSandboxSession = {
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
};

async function fixture(options: { missingResult?: "finish" | "eof" } = {}) {
  const server = new WebSocketServer({ port: 0 });
  cleanup.push(() => {
    for (const client of server.clients) client.terminate();
    server.close();
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture socket");
  const executions: string[] = [];
  const cursors: number[] = [];
  const harness: HarnessV1 = {
    specificationVersion: "harness-v1",
    harnessId: "cursor",
    supportsBuiltinToolApprovals: true,
    builtinTools: {
      fast_write: {
        inputSchema: z.object({ key: z.string(), value: z.string() }),
      },
    },
    doStart: async (start) => {
      const cursor = start.continueFrom
        ? z.object({ cursor: z.number() }).parse(start.continueFrom.data).cursor
        : 0;
      const accepted = once(server, "connection");
      const channel = new SandboxChannel<HarnessV1StreamPart>({
        connect: async () => new WebSocket(`ws://127.0.0.1:${address.port}`),
        outboundSchema: z.custom<HarnessV1StreamPart>(),
        initialLastSeenEventId: cursor,
      });
      await channel.open();
      const [socket] = await accepted;
      let finish!: () => void;
      const send = (part: HarnessV1StreamPart, seq: number) =>
        socket.send(JSON.stringify({ ...part, seq }));
      const begin = async ({
        emit,
      }: {
        emit: (part: HarnessV1StreamPart) => void;
      }): Promise<HarnessV1PromptControl> => {
        for (const type of [
          "tool-call",
          "tool-approval-request",
          "tool-result",
          "finish-step",
          "finish",
        ] as const)
          channel.on(type, emit);
        channel.on("finish", () => finish());
        channel.onClose(() => finish());
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        queueMicrotask(() => {
          calls.forEach((part, index) => {
            if (index + 1 > cursor) send(part, index + 1);
          });
        });
        return {
          submitToolResult: async () => {},
          submitToolApproval: async ({ approvalId, approved }) => {
            await setImmediate();
            const id = approvalId === "approval-1" ? 1 : 2;
            if (approved) executions.push(approvalId);
            if (options.missingResult) {
              if (options.missingResult === "eof") {
                channel.beginClose();
                socket.close();
                return;
              }
              send(
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  totalUsage: usage,
                },
                10,
              );
              return;
            }
            if (approved)
              send(
                {
                  type: "tool-result",
                  toolCallId: `call-${id}`,
                  toolName: "fast_write",
                  result: { wrote: id },
                  isError: false,
                },
                id === 1 ? 7 : 8,
              );
            if (id === 2) {
              send(
                {
                  type: "finish-step",
                  finishReason: { unified: "stop", raw: undefined },
                  usage,
                },
                9,
              );
              send(
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  totalUsage: usage,
                },
                10,
              );
            }
          },
          done,
        };
      };
      return {
        sessionId: start.sessionId,
        isResume: cursor > 0,
        doPromptTurn: begin,
        doContinueTurn: begin,
        doCompact: async () => {},
        doSuspendTurn: async () => {
          const nextCursor = await channel.suspend();
          cursors.push(nextCursor);
          return {
            type: "continue-turn",
            harnessId: "cursor",
            specificationVersion: "harness-v1",
            data: { cursor: nextCursor },
          };
        },
        doDetach: async () => {
          channel.close();
          return {
            type: "resume-session",
            harnessId: "cursor",
            specificationVersion: "harness-v1",
            data: { cursor: channel.lastSeenEventId },
          };
        },
        doStop: async () => {
          channel.close();
          return {
            type: "resume-session",
            harnessId: "cursor",
            specificationVersion: "harness-v1",
            data: { cursor: channel.lastSeenEventId },
          };
        },
        doDestroy: async () => {
          channel.close();
        },
      };
    },
  };
  const agent = new HarnessAgent({ harness, permissionMode: "allow-reads" });
  return { agent, executions, cursors };
}

async function partsOf(stream: AsyncIterable<{ type: string }>) {
  const parts: Array<{ type: string }> = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("real HarnessAgent parallel approval lifecycle", () => {
  it("keeps the first execution live and exposes the second identical call separately", async () => {
    const { agent, executions, cursors } = await fixture();
    const first = await agent.createSession({
      sessionId: "s",
      sandboxSession: sandbox,
    });
    const firstOutput = await agent.stream({
      session: first,
      prompt: "write twice",
    });
    const shown = await partsOf(firstOutput.fullStream);
    expect(
      shown.filter((p) => p.type === "tool-approval-request"),
    ).toHaveLength(1);
    const state = await first.suspendTurn();
    expect(cursors).toEqual([3]);
    const second = await agent.createSession({
      sessionId: "s",
      sandboxSession: sandbox,
      continueFrom: state,
    });
    const continued = await agent.continueStream({
      session: second,
      toolApprovalContinuations: [{ approvalId: "approval-1", approved: true }],
    });
    const nextParts = await partsOf(continued.fullStream);
    expect(nextParts.some((p) => p.type === "tool-result")).toBe(true);
    expect(
      nextParts.filter((p) => p.type === "tool-approval-request"),
    ).toHaveLength(1);
    const next = await second.suspendTurn();
    expect(cursors).toEqual([3, 7]);
    expect(executions).toEqual(["approval-1"]);
    const third = await agent.createSession({
      sessionId: "s",
      sandboxSession: sandbox,
      continueFrom: next,
    });
    const last = await agent.continueStream({
      session: third,
      toolApprovalContinuations: [{ approvalId: "approval-2", approved: true }],
    });
    const lastParts = await partsOf(last.fullStream);
    expect(lastParts.some((p) => p.type === "error")).toBe(false);
    expect(
      lastParts.filter((p) => p.type === "tool-approval-request"),
    ).toHaveLength(0);
    expect(executions).toEqual(["approval-1", "approval-2"]);
    await third.destroy();
  });

  it("does not wait for a result from a denied native call", async () => {
    const { agent, executions, cursors } = await fixture();
    const first = await agent.createSession({
      sessionId: "s",
      sandboxSession: sandbox,
    });
    await partsOf(
      (await agent.stream({ session: first, prompt: "write" })).fullStream,
    );
    const state = await first.suspendTurn();
    const second = await agent.createSession({
      sessionId: "s",
      sandboxSession: sandbox,
      continueFrom: state,
    });
    const output = await agent.continueStream({
      session: second,
      toolApprovalContinuations: [
        { approvalId: "approval-1", approved: false },
      ],
    });
    expect(
      (await partsOf(output.fullStream)).filter(
        (p) => p.type === "tool-approval-request",
      ),
    ).toHaveLength(1);
    await second.suspendTurn();
    expect(cursors).toEqual([3, 6]);
    expect(executions).toEqual([]);
  });

  it.each(["finish", "eof"] as const)(
    "reports an error on %s without an approved result",
    async (missingResult) => {
      const { agent } = await fixture({ missingResult });
      const first = await agent.createSession({
        sessionId: "s",
        sandboxSession: sandbox,
      });
      await partsOf(
        (await agent.stream({ session: first, prompt: "write" })).fullStream,
      );
      const state = await first.suspendTurn();
      const second = await agent.createSession({
        sessionId: "s",
        sandboxSession: sandbox,
        continueFrom: state,
      });
      const output = await agent.continueStream({
        session: second,
        toolApprovalContinuations: [
          { approvalId: "approval-1", approved: true },
        ],
      });
      expect(
        (await partsOf(output.fullStream)).some((p) => p.type === "error"),
      ).toBe(true);
      await second.destroy();
    },
  );
});
