import { describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import type { InputAnswer } from "@mcpjam/sdk/contract";
import { exchangeSpan } from "../../../../shared/eval-input-exchange.js";
import { serveMock, type MockDoor } from "../../mock/route.js";
import { resolvedMock } from "../../mock/__tests__/helpers.js";
import {
  createInputAnswerResolver,
  inputAnswerResolverFor,
  loadInputAnswers,
  loadPinnedInputAnswers,
  withToolCallScope,
  withInputAnswerResolverScope,
} from "../input-answers.js";
import { runPinnedTurn } from "../pinned-turn.js";

const answers: InputAnswer[] = [
  {
    server: "files",
    tool: "cleanup",
    message: "Delete",
    action: "accept",
    content: { sure: true },
  },
  { message: "Sign in", action: "decline" },
];

describe("the resolver", () => {
  it("answers the callback on server and message, names the exchange and declines what no reply fits", async () => {
    const resolver = createInputAnswerResolver({ answers });
    resolver.useServerNames({ srv1: "files" });
    const reply = await resolver.elicitationCallback({
      requestId: "r1",
      message: "Delete /tmp?",
      schema: {},
      serverId: "srv1",
    });
    // The tool is known only inside a tool call, so outside one the first entry cannot fit.
    expect(reply).toEqual({ action: "decline" });
    expect(resolver.exchanges[0]).toMatchObject({
      server: "files",
      note: expect.stringContaining("no reply was set"),
    });

    const inside = await withToolCallScope({ tool: "cleanup" }, () =>
      resolver.elicitationCallback({
        requestId: "r2",
        message: "Delete /tmp?",
        schema: {},
        serverId: "srv1",
      }),
    );
    expect(inside).toEqual({ action: "accept", content: { sure: true } });
    expect(resolver.exchanges[1]).toMatchObject({
      tool: "cleanup",
      action: "accept",
      replyIndex: 0,
    });
  });

  it("consumes duplicate messages in saved order for each pinned invocation", async () => {
    const resolver = createInputAnswerResolver({
      answers: [
        { tool: "cleanup", message: "Confirm", action: "accept", content: { confirmation: "first" } },
        { tool: "cleanup", message: "Confirm", action: "accept", content: { confirmation: "second" } },
      ],
    });
    const question = { requestId: "ask", serverId: "files", message: "Confirm", schema: {} };
    await withInputAnswerResolverScope(resolver, async () => {
      for (let call = 0; call < 2; call++) {
        await withToolCallScope({ tool: "cleanup", serverId: "files", orderedAnswers: true }, async () => {
          expect(await resolver.elicitationCallback(question)).toMatchObject({ content: { confirmation: "first" } });
          expect(await resolver.elicitationCallback(question)).toMatchObject({ content: { confirmation: "second" } });
          expect(await resolver.elicitationCallback(question)).toEqual({ action: "decline" });
        });
      }
    });
  });

  it("takes the tool from the operation on the 2026-07-28 collector, and the exchange is told to the call", async () => {
    const resolver = createInputAnswerResolver({ answers });
    resolver.useServerNames({ srv1: "files" });
    const recorded: unknown[] = [];
    const responses = await withToolCallScope(
      { tool: "other", record: (e) => recorded.push(e) },
      () =>
        resolver.collectorFor("srv1")({
          state: {
            opId: "o",
            method: "tools/call",
            originalParams: { name: "cleanup", arguments: {} },
            round: 0,
            maxRounds: 4,
          } as never,
          inputRequests: {
            a: {
              method: "elicitation/create",
              params: { message: "Delete everything?", mode: "form" },
            },
          } as never,
        }),
    );
    expect(responses).toEqual({
      a: { action: "accept", content: { sure: true } },
    });
    expect(recorded).toHaveLength(1);
  });

  it("answers a task's question through the same replies", async () => {
    const resolver = createInputAnswerResolver({ answers });
    const reply = await resolver.taskHandlers.elicitation!(
      { message: "Sign in to continue", mode: "url" },
      { taskId: "t", serverId: "srv1", inputKey: "k" },
    );
    expect(reply).toEqual({ action: "decline" });
    expect(resolver.exchanges[0]).toMatchObject({
      mode: "url",
      note: expect.stringContaining("URL questions are unsupported"),
    });
  });
});

describe("the exchange in the trace", () => {
  it("is a step span with no tool identity, so no reader counts it as a tool call", () => {
    const span = exchangeSpan(
      {
        kind: "question",
        message: "Delete /tmp?",
        action: "accept",
        replyIndex: 0,
      },
      { id: "ask-1", parentId: "tool-1", startMs: 5, endMs: 5 },
    );
    expect(span).toMatchObject({
      category: "step",
      parentId: "tool-1",
      name: 'Question: "Delete /tmp?" -> accept',
    });
    expect(span.toolCallId).toBeUndefined();
    expect(span.toolName).toBeUndefined();
    expect(span.toolOrigin).toBeUndefined();
  });

  it("says when no reply was set", () => {
    const span = exchangeSpan(
      {
        kind: "question",
        message: "Anything?",
        action: "decline",
        note: "declined, no reply was set for this question",
      },
      { id: "ask-2", startMs: 0, endMs: 0 },
    );
    expect(span.name).toContain("no reply was set");
  });
});

describe("loading the replies before connect", () => {
  it("fetches only a directly launched case's replies", async () => {
    const query = vi.fn(async () => ({ inputAnswers: [answers[0]!] }));
    expect(await loadInputAnswers({ query } as never, { suiteId: "s1" })).toEqual([]);
    expect(await loadInputAnswers({ query } as never, {})).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    const resolver = await inputAnswerResolverFor({ query } as never, {
      testCaseId: "c1",
    });
    expect(resolver?.answers).toEqual([answers[0]]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("treats a backend that has no such function as having no replies, and refuses the run on any other failure", async () => {
    const old = vi.fn(async () => {
      throw new Error("Could not find public function for 'testSuites:x'");
    });
    expect(
      await loadInputAnswers({ query: old } as never, { testCaseId: "c" }),
    ).toEqual([]);
    const down = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      loadInputAnswers({ query: down } as never, { testCaseId: "c" }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("couldn't load"),
    });
  });
});

describe("the harness proxy's replies", () => {
  it("allows a backend that has yet to deploy the replies endpoint", async () => {
    expect(await loadPinnedInputAnswers(
      { runId: "older", iterationId: "older" },
      async () => ({ status: 404, body: null }),
    )).toEqual([]);
  });

  it("reads an iteration's pinned replies once a minute and refuses on a failed read", async () => {
    let clock = 0;
    const transport = vi.fn(async () => ({
      status: 200,
      body: { ok: true, inputAnswers: answers },
    }));
    const scope = { runId: "r-proxy", iterationId: "i-proxy" };
    expect(await loadPinnedInputAnswers(scope, transport, () => clock)).toEqual(
      answers,
    );
    clock = 30_000;
    await loadPinnedInputAnswers(scope, transport, () => clock);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith("input-answers", scope, {});
    clock = 61_000;
    await loadPinnedInputAnswers(scope, transport, () => clock);
    expect(transport).toHaveBeenCalledTimes(2);

    await expect(
      loadPinnedInputAnswers(
        { runId: "r2", iterationId: "i2" },
        async () => ({ status: 500, body: null }),
        () => 0,
      ),
    ).rejects.toThrow(/couldn't load the replies/);
  });
});

/** The pieces `createAuthorizedManager` registers, on a connection to a mock that asks. */
const door: MockDoor = {
  kind: "in-process",
  grant: "grant-for-ann",
  bearerToken: "bearer-ann",
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  projectId: "proj1",
  profile: { timeoutMs: 5_000 },
};
const asking = resolvedMock({
  baseServerId: undefined,
  definition: {
    tools: {
      cleanup: {
        inputSchema: {
          type: "object",
          properties: { dir: { type: "string" } },
        },
        answer: {
          from: "saved",
          cases: [
            {
              steps: [
                {
                  kind: "ask",
                  id: "sure",
                  message: "Delete {{input.dir}}?",
                  requestedSchema: {
                    type: "object",
                    properties: { sure: { type: "boolean" } },
                  },
                },
              ],
              result: {
                content: [
                  {
                    type: "text",
                    text: "{{steps.sure.action}} {{steps.sure.content.sure}}",
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
});

describe("a 2026-07-28 question from a stateless mock", () => {
  async function run(replies: InputAnswer[], expectedQuestions?: number) {
    const resolver = createInputAnswerResolver({ answers: replies });
    const deps = {
      resolve: vi.fn(async () => asking),
    };
    // Registered before connect, as `createAuthorizedManager` does.
    const manager = new MCPClientManager();
    manager.setElicitationCallback(resolver.elicitationCallback);
    manager.setMrtrInputCollector("mock", resolver.collectorFor("mock"));
    resolver.useServerNames({ mock: "files" });
    await manager.connectToServer("mock", {
      url: "https://mock.mcpjam.invalid/mock1",
      mcpProtocolVersion: "2026-07-28",
      baseFetch: (input, init) =>
        serveMock(new Request(input as string, init), "mock1", door, deps),
    } as never);
    try {
      const pinned = await runPinnedTurn({
        pinned: {
          serverName: "files",
          toolName: "cleanup",
          arguments: { dir: "/tmp/x" },
        },
        resolvedServerKey: "mock",
        mcpClientManager: manager,
        browser: { renderPinnedToolResult: vi.fn() },
        promptIndex: 0,
        expectedQuestions,
      });
      return { result: pinned.toolResult, pinned, resolver };
    } finally {
      await manager.disconnectAllServers();
    }
  }

  it("gives the reply the case set, matched on server, tool and message", async () => {
    const { result, pinned, resolver } = await run(answers, 1);
    expect(pinned.iterationError).toBeUndefined();
    expect(result).toMatchObject({
      content: [{ type: "text", text: "accept true" }],
    });
    expect(resolver.exchanges).toEqual([
      expect.objectContaining({
        server: "files",
        tool: "cleanup",
        message: "Delete /tmp/x?",
        action: "accept",
        replyIndex: 0,
      }),
    ]);
  });

  it("declines when no reply was set and says so", async () => {
    const { result, pinned, resolver } = await run([], 1);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "decline {{steps.sure.content.sure}}" }],
    });
    expect(pinned.iterationError).toContain("Expected 1 form questions");
    expect(resolver.exchanges[0]).toMatchObject({
      action: "decline",
      note: expect.stringContaining("no reply was set"),
    });
  });
});


it("gives a legacy stdio server only its case's tool-scoped reply", async () => {
  const script = `
    const { createInterface } = require("node:readline");
    const write = (message) => process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      ...message,
    }) + "\\n");
    let toolId;
    let supportsQuestions;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      switch (message.method) {
        case "server/discover":
          write({ id: message.id, error: { code: -32601, message: "Method not found" } });
          break;
        case "initialize":
          supportsQuestions = Boolean(message.params.capabilities?.elicitation);
          write({ id: message.id, result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "stdio-files", version: "1" },
          } });
          break;
        case "tools/list":
          write({ id: message.id, result: { tools: [
            { name: "cleanup", inputSchema: { type: "object" } },
          ] } });
          break;
        case "tools/call":
          if (!supportsQuestions) {
            write({ id: message.id, result: { content: [{ type: "text", text: "no questions" }] } });
            break;
          }
          toolId = message.id;
          write({ id: "delete", method: "elicitation/create", params: {
            mode: "form",
            message: "Delete scratch file?",
            requestedSchema: { type: "object", properties: { sure: { type: "boolean" } } },
          } });
          break;
        default:
          if (message.id === "delete") {
            const reply = message.result ?? message.error;
            write({ id: toolId, result: {
              content: [{ type: "text", text: JSON.stringify(reply) }],
            } });
          }
      }
    });
  `;
  const withReplies = new MCPClientManager();
  const noReplies = new MCPClientManager();
  const resolver = createInputAnswerResolver({ answers });
  resolver.useServerNames({ stdio: "files" });
  withReplies.setElicitationCallback(resolver.elicitationCallback);
  const config = {
    command: process.execPath,
    args: ["-e", script],
    mcpProtocolVersion: "2025-11-25" as const,
    timeout: 5000,
  };
  try {
    await Promise.all([
      withReplies.connectToServer("stdio", config),
      noReplies.connectToServer("stdio", config),
    ]);
    const [configured, plain] = await Promise.all([
      withInputAnswerResolverScope(resolver, () =>
        withToolCallScope({ tool: "cleanup", serverId: "stdio" }, () =>
          withReplies.executeTool("stdio", "cleanup", {}),
        ),
      ),
      noReplies.executeTool("stdio", "cleanup", {}),
    ]);
    expect(configured).toMatchObject({
      content: [{ text: JSON.stringify({ action: "accept", content: { sure: true } }) }],
    });
    expect(plain).toMatchObject({ content: [{ text: "no questions" }] });
  } finally {
    await Promise.all([withReplies.disconnectAllServers(), noReplies.disconnectAllServers()]);
  }
});
