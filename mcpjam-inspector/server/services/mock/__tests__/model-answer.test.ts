import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { MockAnswerError } from "@mcpjam/sdk/mocks";
import {
  convexAnswersBackend,
  type AnswersBackend,
  type StoredModelAnswer,
} from "../answers-backend.js";
import { createModelAnswerer, type ModelCaller } from "../model-answer.js";
import { mockConnectionPool } from "../connection.js";
import { resetUnmatchedReportsForTests } from "../unmatched.js";
import { serveMock, type MockDoor } from "../route.js";
import { dialMock, resolvedMock, stubRealServer } from "./helpers.js";

const tool = {
  name: "list_invoices",
  description: "Lists invoices.",
  inputSchema: {
    type: "object" as const,
    properties: { customer: { type: "string" } },
  },
};

/** An in-memory stand-in for the backend: one store and one count, as every replica sees. */
function memoryBackend(caps: { version?: number } = {}) {
  const answers = new Map<string, StoredModelAnswer>();
  const state = { reserved: 0 };
  const backend: AnswersBackend = {
    lookup: async (k) =>
      answers.get(`${k.mockId}:${k.version}:${k.tool}:${k.inputHash}`),
    reserve: async () => {
      if (state.reserved >= (caps.version ?? 200)) {
        throw new MockAnswerError(
          "This mock version has used its model answers. Save a new version.",
        );
      }
      state.reserved += 1;
    },
    store: async (k, answer) => {
      const key = `${k.mockId}:${k.version}:${k.tool}:${k.inputHash}`;
      if (!answers.has(key)) answers.set(key, answer);
      return answers.get(key)!;
    },
  };
  return { backend, state, answers };
}

const modelReply = (text: string): ModelCaller =>
  vi.fn(async () => ({ text, model: "test-model" }));
const request = (args: Record<string, unknown>) => ({
  tool,
  serverName: "billing",
  arguments: args,
});

describe("createModelAnswerer", () => {
  it("asks the model on first use, stores the answer, and replays it with no second model call", async () => {
    const { backend, state } = memoryBackend();
    const callModel = modelReply(
      '{"content":[{"type":"text","text":"INV-1"}]}',
    );
    const answer = createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel,
    });
    const first = await answer(request({ customer: "acme" }));
    expect(first).toEqual({
      result: { content: [{ type: "text", text: "INV-1" }] },
      outcome: "generated",
    });
    // A second answerer, as another replica would build, replays what was stored.
    const other = createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel,
    });
    const second = await other(request({ customer: "acme" }));
    expect(second).toEqual({ result: first.result, outcome: "stored" });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(state.reserved).toBe(1);
  });

  it("keys on mock version, tool and the input, whatever the order of its keys", async () => {
    const { backend } = memoryBackend();
    const callModel = modelReply("text answer");
    const a = createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel,
    });
    await a(request({ x: 1, y: 2 }));
    await a(request({ y: 2, x: 1 }));
    expect(callModel).toHaveBeenCalledTimes(1);
    await a(request({ x: 1, y: 3 }));
    await createModelAnswerer({ mockId: "m", version: 2, backend, callModel })(
      request({ x: 1, y: 2 }),
    );
    expect(callModel).toHaveBeenCalledTimes(3);
  });

  it("makes one model call for calls that arrive together", async () => {
    const { backend, state } = memoryBackend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const callModel: ModelCaller = vi.fn(async () => {
      await gate;
      return { text: "one", model: "test-model" };
    });
    const answer = createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel,
    });
    const both = Promise.all([
      answer(request({ a: 1 })),
      answer(request({ a: 1 })),
    ]);
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1));
    release();
    const [x, y] = await both;
    expect(x.result).toEqual(y.result);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(state.reserved).toBe(1);
  });

  it("stops at the cap, in the backend's words, with no model call", async () => {
    const { backend } = memoryBackend({ version: 1 });
    const callModel = modelReply("a");
    const answer = createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel,
    });
    await answer(request({ n: 1 }));
    await expect(answer(request({ n: 2 }))).rejects.toThrow(
      "used its model answers",
    );
    expect(callModel).toHaveBeenCalledTimes(1);
    // What was stored still replays after the cap is reached.
    expect((await answer(request({ n: 1 }))).outcome).toBe("stored");
  });

  it("turns a model failure into a refusal that says what to do, and stores nothing", async () => {
    const { backend, answers } = memoryBackend();
    const callModel: ModelCaller = vi.fn(async () => {
      throw new Error("provider 500 for key sk-secret");
    });
    const answer = createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel,
    });
    const failure = await answer(request({ n: 1 })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MockAnswerError);
    expect((failure as Error).message).toContain("Try the call again");
    expect((failure as Error).message).not.toContain("sk-secret");
    expect(answers.size).toBe(0);
  });

  it("hands the run key to the count", async () => {
    const reserve = vi.fn(async () => {});
    const backend: AnswersBackend = { ...memoryBackend().backend, reserve };
    await createModelAnswerer({
      mockId: "m",
      version: 1,
      backend,
      callModel: modelReply("t"),
      runKey: "run-7",
    })(request({}));
    expect(reserve).toHaveBeenCalledWith({
      mockId: "m",
      version: 1,
      runKey: "run-7",
    });
  });
});

describe("convexAnswersBackend", () => {
  const caller = { authMethod: "authkit_jwt" as const, workosUserId: "ann" };
  const key = { mockId: "m", version: 1, tool: "t", inputHash: "h" };
  beforeEach(() => vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test"));
  afterEach(() => vi.unstubAllEnvs());
  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("looks up, reserves and stores through the caller's bearer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ found: false }))
      .mockResolvedValueOnce(json({ reserved: true }))
      .mockResolvedValueOnce(
        json({ stored: true, answerJson: "{}", model: "m1" }),
      );
    const backend = convexAnswersBackend(caller, "tok", {
      fetch: fetchMock as never,
    });
    expect(await backend.lookup(key)).toBeUndefined();
    await backend.reserve({ mockId: "m", version: 1, runKey: "r" });
    expect(await backend.store(key, { answerJson: "{}", model: "m1" })).toEqual(
      { answerJson: "{}", model: "m1" },
    );
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://convex.test/web/mock/answers/lookup",
      "https://convex.test/web/mock/answers/reserve",
      "https://convex.test/web/mock/answers/store",
    ]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  it("passes the backend's cap message on, and refuses when the backend cannot be asked", async () => {
    const capped = convexAnswersBackend(caller, "tok", {
      fetch: (async () =>
        json(
          { code: "MOCK_MODEL_CAP_REACHED", message: "Used up. Save cases." },
          429,
        )) as never,
    });
    await expect(capped.reserve({ mockId: "m", version: 1 })).rejects.toThrow(
      "Used up. Save cases.",
    );
    const down = convexAnswersBackend(caller, "tok", {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });
    await expect(down.lookup(key)).rejects.toThrow("could not reach its store");
    const refused = convexAnswersBackend(caller, "tok", {
      fetch: (async () => json({ code: "MOCK_FORBIDDEN" }, 403)) as never,
    });
    await expect(refused.lookup(key)).rejects.toThrow(
      "could not reach its store",
    );
  });
});

describe("a model-answered tool at the route", () => {
  const door: MockDoor = {
    kind: "in-process",
    grant: "g",
    bearerToken: "b",
    caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
    projectId: "proj1",
    profile: { timeoutMs: 5_000 },
  };
  const modelMock = resolvedMock({
    baseServerId: null,
    definition: {
      tools: {
        list_invoices: {
          inputSchema: tool.inputSchema,
          answer: { from: "model", instructions: "Two invoices." },
        },
      },
    },
  });
  beforeEach(() => resetUnmatchedReportsForTests());
  afterEach(async () => mockConnectionPool.clear());

  it("answers a mock from nothing with the model once, then replays, with no mark in the result", async () => {
    const { backend } = memoryBackend();
    const callModel = modelReply(
      '{"content":[{"type":"text","text":"INV-1, INV-2"}]}',
    );
    const deps = {
      open: stubRealServer().open,
      resolve: vi.fn(async () => modelMock),
      recordUnmatched: vi.fn(),
      modelAnswerer: (mock: {
        mockId: string;
        version: number;
        runKey?: string;
      }) => createModelAnswerer({ ...mock, backend, callModel }),
    };
    const marks: Array<string | null> = [];
    const client = await dialMock(async (r) => {
      const response = await serveMock(r, "mock1", door, deps);
      marks.push(response.headers.get("x-mcpjam-mock-answered"));
      return response;
    });
    for (let i = 0; i < 2; i++) {
      const result = (await client.executeTool("mock", "list_invoices", {
        customer: "acme",
      })) as {
        content: Array<{ text: string }>;
      };
      expect(result.content).toEqual([{ type: "text", text: "INV-1, INV-2" }]);
    }
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(marks).toContain("list_invoices=model");
    await client.disconnectAllServers();
  });
});
