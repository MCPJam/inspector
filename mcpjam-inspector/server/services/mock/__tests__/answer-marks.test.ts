import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { evalTraceSpanZ } from "../../../../shared/eval-trace.js";
import {
  createAiSdkEvalTraceContext,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../../evals/eval-trace-capture.js";
import { mockConnectionPool } from "../connection.js";
import { observeMockAnswered, parseMockAnswered } from "../answer-marks.js";
import { serveMock, type MockDoor } from "../route.js";
import { resetUnmatchedReportsForTests } from "../unmatched.js";
import { dialMock, resolvedMock, stubRealServer } from "./helpers.js";

const context = {
  bearerToken: "bearer-ann",
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  profile: { timeoutMs: 5_000 },
};
const doors: Record<string, MockDoor> = {
  "in-process": { kind: "in-process", grant: "grant-ann", projectId: "proj1", ...context },
  http: { kind: "http", ...context },
};

const saved = resolvedMock({
  definition: {
    tools: {
      echo: {
        answer: {
          from: "saved",
          cases: [{ when: { message: "hello" }, result: { content: [{ type: "text", text: "saved: hello" }] } }],
        },
      },
    },
  },
});

beforeEach(() => {
  resetUnmatchedReportsForTests();
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await mockConnectionPool.clear();
});

describe("parseMockAnswered", () => {
  it("reads tool=source pairs, decodes names and drops what does not parse", () => {
    expect(parseMockAnswered("echo=saved,a%2Cb=model,bad,x=real,%E0=saved")).toEqual([
      { tool: "echo", source: "saved" },
      { tool: "a,b", source: "model" },
    ]);
    expect(parseMockAnswered(null)).toEqual([]);
  });
});

describe.each(Object.keys(doors))("V9: the trace marks a mock's answer (%s door)", (kind) => {
  async function callEcho(message: string) {
    const stub = stubRealServer();
    const deps = { open: stub.open, resolve: vi.fn(async () => saved), recordUnmatched: vi.fn() };
    // The dialer's own fetch, as the connection builds it.
    const client = await dialMock(
      observeMockAnswered((input, init) =>
        serveMock(new Request(input as string, init), "mock1", doors[kind]!, deps),
      ),
    );
    const trace = createAiSdkEvalTraceContext(Date.now());
    registerAiSdkPrepareStep(trace, 0);
    const tools = wrapToolSetForEvalTrace(
      {
        echo: {
          _serverId: "mock",
          execute: (input: unknown) => client.executeTool("mock", "echo", input as Record<string, unknown>),
        },
      },
      trace,
    );
    const result = await tools.echo.execute({ message }, { toolCallId: "call1" });
    await client.disconnectAllServers();
    return { result, spans: trace.recordedSpans };
  }

  it("a saved answer gets a mark under the tool call and none in the result", async () => {
    const { result, spans } = await callEcho("hello");
    expect(JSON.stringify(result)).not.toMatch(/mock|answered/i);
    const tool = spans.find((s) => s.category === "tool")!;
    const mark = spans.find((s) => s.id === "mock-call1")!;
    expect(mark).toMatchObject({
      parentId: tool.id,
      name: "Answered by the mock: its saved answer",
      category: "step",
    });
    // Not a tool call to any reader, and the tool span itself is unchanged.
    expect(evalTraceSpanZ.parse(mark).toolName).toBeUndefined();
    expect(spans.filter((s) => s.category === "tool")).toHaveLength(1);
  });

  it("a call the real server answers has no mark", async () => {
    const { spans } = await callEcho("other");
    expect(spans.some((s) => s.id === "mock-call1")).toBe(false);
  });
});
