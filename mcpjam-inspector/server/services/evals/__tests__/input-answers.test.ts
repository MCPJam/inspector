import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import { createMockSessionMap } from "@mcpjam/sdk/mocks";
import type { InputAnswer } from "@mcpjam/sdk/contract";
import { exchangeSpan } from "../../../../shared/eval-input-exchange.js";
import { mockConnectionPool } from "../../mock/connection.js";
import { serveMock, type MockDoor } from "../../mock/route.js";
import { resolvedMock, stubRealServer } from "../../mock/__tests__/helpers.js";
import {
  createInputAnswerResolver,
  inputAnswerResolverFor,
  loadInputAnswers,
  loadPinnedInputAnswers,
  runWithIterationExchanges,
  withToolCallScope,
  type ModelRequestAnswerer,
} from "../input-answers.js";

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
      replyIndex: 1,
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
  const cases = [
    { _id: "c1", inputAnswers: [answers[0]!] },
    { _id: "c2" },
    { _id: "c3", inputAnswers: [answers[1]!] },
  ];

  it("takes one case's for a quick run and pools a suite's in case order", async () => {
    const query = vi.fn(async (_ref: unknown, args: Record<string, string>) =>
      args.testCaseId ? cases[0] : cases,
    );
    expect(
      await loadInputAnswers({ query } as never, { testCaseId: "c1" }),
    ).toEqual({ pooled: [answers[0]], byCase: { c1: [answers[0]] } });
    expect(
      await loadInputAnswers({ query } as never, { suiteId: "s1" }),
    ).toEqual({
      pooled: answers,
      byCase: { c1: [answers[0]], c2: [], c3: [answers[1]] },
    });
    expect(await loadInputAnswers({ query } as never, {})).toEqual({
      pooled: [],
      byCase: {},
    });
    const resolver = await inputAnswerResolverFor({ query } as never, {
      suiteId: "s1",
    });
    expect(resolver.answers).toEqual(answers);
  });

  it("treats a backend that has no such function as having no replies, and refuses the run on any other failure", async () => {
    const old = vi.fn(async () => {
      throw new Error("Could not find public function for 'testSuites:x'");
    });
    expect(
      await loadInputAnswers({ query: old } as never, { suiteId: "s" }),
    ).toEqual({ pooled: [], byCase: {} });
    const down = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      loadInputAnswers({ query: down } as never, { suiteId: "s" }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("didn't start"),
    });
  });
});

describe("the harness proxy's replies", () => {
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

describe.each(["2025-06-18", "2026-07-28"])(
  "a question from a mock, answered by the case's reply (revision %s)",
  (version) => {
    let stub: ReturnType<typeof stubRealServer>;
    beforeEach(() => {
      stub = stubRealServer();
    });
    afterEach(async () => {
      await mockConnectionPool.clear();
    });

    async function run(replies: InputAnswer[]) {
      const resolver = createInputAnswerResolver({ answers: replies });
      const sessions = createMockSessionMap();
      const deps = {
        open: stub.open,
        resolve: vi.fn(async () => asking),
        sessions,
      };
      // Registered before connect, as `createAuthorizedManager` does.
      const manager = new MCPClientManager();
      manager.setElicitationHandler(
        "mock",
        resolver.elicitationHandlerFor("mock"),
      );
      manager.setMrtrInputCollector("mock", resolver.collectorFor("mock"));
      resolver.useServerNames({ mock: "files" });
      await manager.connectToServer("mock", {
        url: "https://mock.mcpjam.invalid/mock1",
        mcpProtocolVersion: version,
        baseFetch: (input, init) =>
          serveMock(new Request(input as string, init), "mock1", door, deps),
      } as never);
      const result = (await withToolCallScope({ tool: "cleanup" }, () =>
        manager.executeTool("mock", "cleanup", { dir: "/tmp/x" }),
      )) as { content: Array<{ text: string }> };
      await manager.disconnectAllServers();
      await sessions.closeAll();
      return { result, resolver };
    }

    it("gives the reply the case set, matched on server, tool and message", async () => {
      const { result, resolver } = await run(answers);
      expect(result.content).toEqual([{ type: "text", text: "accept true" }]);
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
      const { result, resolver } = await run([]);
      expect(result.content).toEqual([
        { type: "text", text: "decline {{steps.sure.content.sure}}" },
      ]);
      expect(resolver.exchanges[0]).toMatchObject({
        action: "decline",
        note: expect.stringContaining("no reply was set"),
      });
    });
  },
);

const asksModel = resolvedMock({
  baseServerId: undefined,
  definition: {
    tools: {
      summarize: {
        inputSchema: {
          type: "object",
          properties: { file: { type: "string" } },
        },
        answer: {
          from: "saved",
          cases: [
            {
              steps: [
                {
                  kind: "sample",
                  id: "gist",
                  prompt: "Summarize {{input.file}} in one line.",
                  systemPrompt: "You are terse.",
                  maxTokens: 40,
                },
              ],
              result: {
                content: [{ type: "text", text: "gist: {{steps.gist.text}}" }],
              },
            },
          ],
        },
      },
    },
  },
});

describe.each(["2025-06-18", "2026-07-28"])(
  "a request for the model from a mock, answered by the iteration's model (revision %s)",
  (version) => {
    let stub: ReturnType<typeof stubRealServer>;
    beforeEach(() => {
      stub = stubRealServer();
    });
    afterEach(async () => {
      await mockConnectionPool.clear();
    });

    async function run(answerModel?: ModelRequestAnswerer) {
      const resolver = createInputAnswerResolver({ answers: [] });
      const sessions = createMockSessionMap();
      const deps = {
        open: stub.open,
        resolve: vi.fn(async () => asksModel),
        sessions,
      };
      // Registered before connect, as `createAuthorizedManager` does.
      const manager = new MCPClientManager();
      manager.setElicitationHandler(
        "mock",
        resolver.elicitationHandlerFor("mock"),
      );
      manager.setSamplingCallback("mock", resolver.samplingCallback);
      manager.setMrtrInputCollector("mock", resolver.collectorFor("mock"));
      await manager.connectToServer("mock", {
        url: "https://mock.mcpjam.invalid/mock1",
        mcpProtocolVersion: version,
        baseFetch: (input, init) =>
          serveMock(new Request(input as string, init), "mock1", door, deps),
      } as never);
      try {
        const result = (await withToolCallScope(
          { tool: "summarize", answerModel },
          () => manager.executeTool("mock", "summarize", { file: "notes.md" }),
        )) as { content: Array<{ text: string }> };
        return { result, resolver };
      } finally {
        await manager.disconnectAllServers();
        await sessions.closeAll();
      }
    }

    it("sends the server's words to the run's model and gives its text back", async () => {
      const asked: unknown[] = [];
      const { result, resolver } = await run(async (request) => {
        asked.push(request);
        return { text: "It is about cats.", model: "iteration-model" };
      });
      expect(result.content).toEqual([
        { type: "text", text: "gist: It is about cats." },
      ]);
      expect(asked).toEqual([
        expect.objectContaining({
          system: "You are terse.",
          prompt: "Summarize notes.md in one line.",
        }),
      ]);
      expect(resolver.exchanges).toEqual([
        expect.objectContaining({
          kind: "model_request",
          tool: "summarize",
          action: "answered",
          content: { text: "It is about cats.", model: "iteration-model" },
        }),
      ]);
    });

    it("says the run has no model to give when the call runs under none", async () => {
      const outcome = await run(undefined).then(
        (done) => ({ done }),
        (error: Error) => ({ error }),
      );
      if (version === "2026-07-28") {
        // The collector refuses, so the call fails with the words.
        expect(outcome).toMatchObject({
          error: { message: expect.stringContaining("has none to give") },
        });
      } else {
        // The server SDK's session shim turns the client's refusal into a tool error.
        expect(outcome).toMatchObject({ done: { result: { isError: true } } });
      }
    });
  },
);

describe("the iteration's model", () => {
  it("is asked as the person who runs the eval, with the iteration's model and not MCPJam's own", async () => {
    const ask = vi.fn(async () => ({ text: "ok", model: "iter-model" }));
    const hostedModelCaller = vi.fn(() => ask);
    vi.resetModules();
    vi.doMock("../../mock/model-call.js", () => ({ hostedModelCaller }));
    const { iterationModelAnswerer } =
      await import("../iteration-model-answer.js");
    const definition = { id: "iter-model", provider: "anthropic" } as never;
    const answer = iterationModelAnswerer({
      bearer: "Bearer tok-1",
      projectId: "proj1",
      definition,
      modelId: "iter-model",
    });
    expect(await answer({ prompt: "Hi" })).toEqual({
      text: "ok",
      model: "iter-model",
    });
    expect(hostedModelCaller).toHaveBeenCalledWith({
      bearerToken: "tok-1",
      projectId: "proj1",
      model: { definition, id: "iter-model" },
    });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hi",
        system: expect.stringContaining("MCP server"),
      }),
    );
    vi.doUnmock("../../mock/model-call.js");
  });
});

describe.each(["2025-06-18", "2026-07-28"])(
  "replies belong to the case being run (revision %s)",
  (version) => {
    let stub: ReturnType<typeof stubRealServer>;
    beforeEach(() => {
      stub = stubRealServer();
    });
    afterEach(async () => {
      await mockConnectionPool.clear();
    });

    // One connection for the run, as an eval has; two cases answer the same question differently.
    const byCase = {
      "case-a": [
        {
          server: "files",
          tool: "cleanup",
          message: "Delete",
          action: "accept",
          content: { sure: true },
        },
      ],
      "case-b": [
        {
          server: "files",
          tool: "cleanup",
          message: "Delete",
          action: "decline",
        },
      ],
    } satisfies Record<string, InputAnswer[]>;

    async function runCases(caseIds: Array<string | undefined>) {
      const resolver = createInputAnswerResolver({
        answers: [...byCase["case-a"], ...byCase["case-b"]],
        answersByCase: byCase,
      });
      const sessions = createMockSessionMap();
      const deps = {
        open: stub.open,
        resolve: vi.fn(async () => asking),
        sessions,
      };
      const manager = new MCPClientManager();
      manager.setElicitationHandler(
        "mock",
        resolver.elicitationHandlerFor("mock"),
      );
      manager.setMrtrInputCollector("mock", resolver.collectorFor("mock"));
      resolver.useServerNames({ mock: "files" });
      await manager.connectToServer("mock", {
        url: "https://mock.mcpjam.invalid/mock1",
        mcpProtocolVersion: version,
        baseFetch: (input, init) =>
          serveMock(new Request(input as string, init), "mock1", door, deps),
      } as never);
      try {
        const texts: string[] = [];
        for (const caseId of caseIds) {
          const result = (await runWithIterationExchanges(
            () =>
              withToolCallScope({ tool: "cleanup" }, () =>
                manager.executeTool("mock", "cleanup", { dir: "/tmp/x" }),
              ),
            caseId,
          )) as { content: Array<{ text: string }> };
          texts.push(result.content[0]!.text);
        }
        return { texts, resolver };
      } finally {
        await manager.disconnectAllServers();
        await sessions.closeAll();
      }
    }

    it("gives each case its own reply to the same server, tool and message", async () => {
      const { texts, resolver } = await runCases(["case-a", "case-b"]);
      expect(texts).toEqual([
        "accept true",
        "decline {{steps.sure.content.sure}}",
      ]);
      expect(resolver.exchanges.map((e) => e.pooled)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("falls back to the run's pooled replies where the case cannot be known, and says so", async () => {
      const { texts, resolver } = await runCases([undefined]);
      expect(texts).toEqual(["accept true"]);
      expect(resolver.exchanges[0]).toMatchObject({
        pooled: true,
        replyIndex: 0,
      });
      expect(
        exchangeSpan(resolver.exchanges[0]!, { id: "x", startMs: 0, endMs: 0 })
          .name,
      ).toContain("case unknown");
    });
  },
);

describe("which connections declare what", () => {
  const resolver = (
    over: Partial<Parameters<typeof createInputAnswerResolver>[0]> = {},
  ) => createInputAnswerResolver({ answers: [], ...over });

  it("declares elicitation for a mock, and for a real server only when a reply names it", () => {
    const none = resolver();
    expect(none.declaresElicitation({ name: "files", mock: true })).toBe(true);
    expect(none.declaresElicitation({ name: "files", mock: false })).toBe(
      false,
    );
    // A reply that names no server is for mocks and servers named elsewhere, not every real server.
    const anyServer = resolver({ answers: [{ action: "decline" }] });
    expect(anyServer.declaresElicitation({ name: "files", mock: false })).toBe(
      false,
    );
    const named = resolver({
      answers: [{ server: "files", action: "accept" }],
    });
    expect(named.declaresElicitation({ name: "files", mock: false })).toBe(
      true,
    );
    expect(named.declaresElicitation({ name: "web", mock: false })).toBe(false);
    const inACase = resolver({
      answersByCase: { c: [{ server: "web", action: "accept" }] },
    });
    expect(inACase.declaresElicitation({ name: "web", mock: false })).toBe(
      true,
    );
  });

  it("declares sampling only for a mock, and only when the run has an answerer", () => {
    expect(
      resolver({ modelAnswers: true }).declaresSampling({ mock: true }),
    ).toBe(true);
    expect(
      resolver({ modelAnswers: true }).declaresSampling({ mock: false }),
    ).toBe(false);
    expect(resolver().declaresSampling({ mock: true })).toBe(false);
  });
});
