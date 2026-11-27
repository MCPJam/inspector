/**
 * Call outcomes: batched and flushed, a forward's real tool reported, a failed
 * report never failing the call, and nothing but ids and closed words in the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sink = vi.hoisted(() => ({ report: undefined as undefined | ((...a: unknown[]) => void) }));

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));
// The route reports through the module's singleton; the test swaps in a reporter it can read.
vi.mock("../call-outcomes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../call-outcomes.js")>()),
  reportMockOutcome: (...args: unknown[]) => sink.report?.(...args),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { startTicketHttp, type RunningTicketServer } from "../../../routes/mcp/__tests__/helpers/ticket-server.js";
import type { MockCallMark } from "../../../../shared/mock-answer-span.js";
import { MAX_OUTCOMES_PER_BATCH, MockOutcomeReporter, outcomeOf, type OutcomeCaller } from "../call-outcomes.js";
import type { OpenReal } from "../connection.js";
import { serveMock, type MockDoor } from "../route.js";
import { dialMock, resolvedMock } from "./helpers.js";

const who: OutcomeCaller = { caller: { authMethod: "workos_api_key", workosUserId: "ann" }, bearerToken: "ann-token" };
const mark = (over: Partial<MockCallMark> = {}): MockCallMark => ({
  mockId: "mock1",
  version: 2,
  tool: "echo",
  source: "saved",
  ...over,
});

type Sent = { url: string; auth: string | null; body: { outcomes: Array<Record<string, unknown>> } };
function stubBackend(status = 200) {
  const sent: Sent[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(init.body as string),
    });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { sent, fetchStub };
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the reporter", () => {
  it("sends what is waiting once the short timer runs out, as the caller", async () => {
    vi.useFakeTimers();
    const { sent, fetchStub } = stubBackend();
    const reporter = new MockOutcomeReporter({ fetch: fetchStub, flushAfterMs: 1_000 });
    reporter.record("ann", who, outcomeOf(mark()));
    reporter.record("ann", who, outcomeOf(mark({ tool: "other" })));
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://backend.test/web/mock/call-outcomes");
    expect(sent[0].auth).toBe("Bearer ann-token");
    expect(sent[0].body.outcomes.map((o) => o.tool)).toEqual(["echo", "other"]);
  });

  it("sends a full batch at once and never more than 50 in one request", async () => {
    const { sent, fetchStub } = stubBackend();
    const reporter = new MockOutcomeReporter({ fetch: fetchStub });
    for (let i = 0; i < MAX_OUTCOMES_PER_BATCH + 5; i++) reporter.record("ann", who, outcomeOf(mark()));
    await reporter.flush();
    expect(sent.map((s) => s.body.outcomes.length).sort((a, b) => a - b)).toEqual([5, MAX_OUTCOMES_PER_BATCH]);
  });

  it("keeps two callers' outcomes in separate requests under their own credentials", async () => {
    const { sent, fetchStub } = stubBackend();
    const reporter = new MockOutcomeReporter({ fetch: fetchStub });
    reporter.record("ann", who, outcomeOf(mark()));
    reporter.record("bob", { ...who, bearerToken: "bob-token" }, outcomeOf(mark()));
    await reporter.flush();
    expect(sent.map((s) => s.auth).sort()).toEqual(["Bearer ann-token", "Bearer bob-token"]);
  });

  it("flushes at shutdown, and a flush with nothing waiting sends nothing", async () => {
    const { sent, fetchStub } = stubBackend();
    const reporter = new MockOutcomeReporter({ fetch: fetchStub });
    await reporter.flush();
    expect(sent).toHaveLength(0);
    reporter.record("ann", who, outcomeOf(mark()));
    await reporter.flush();
    expect(sent).toHaveLength(1);
  });

  it("drops a report the backend refuses or cannot receive, without throwing", async () => {
    const refused = stubBackend(500);
    const a = new MockOutcomeReporter({ fetch: refused.fetchStub });
    a.record("ann", who, outcomeOf(mark()));
    await expect(a.flush()).resolves.toBeUndefined();
    const down = new MockOutcomeReporter({
      fetch: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    down.record("ann", who, outcomeOf(mark()));
    await expect(down.flush()).resolves.toBeUndefined();
    // Dropped, not queued again.
    await down.flush();
    expect(refused.sent).toHaveLength(1);
  });

  it("puts only ids and closed words in an entry", () => {
    const entry = outcomeOf({
      ...mark({ source: "forwarded", realTool: "real_echo", realServerId: "real1" }),
      arguments: { secret: "s3cret" },
      result: { text: "payload" },
    } as MockCallMark);
    expect(entry).toEqual({ mockId: "mock1", version: 2, tool: "echo", source: "forwarded", realTool: "real_echo" });
    expect(JSON.stringify(entry)).not.toMatch(/s3cret|payload|real1/);
  });

  it("carries the saved case that answered and flags a catch-all", () => {
    expect(outcomeOf(mark({ source: "saved", caseIndex: 2 }))).toMatchObject({ caseIndex: 2 });
    expect(outcomeOf(mark({ source: "saved", caseIndex: 2 })).catchAll).toBeUndefined();
    expect(outcomeOf(mark({ source: "saved", caseIndex: 0, catchAll: true }))).toMatchObject({
      caseIndex: 0,
      catchAll: true,
    });
  });

  it("leaves out a refusal that is not a short lowercase word", () => {
    expect(outcomeOf(mark({ source: "blocked", refusal: "blocked_by_policy" })).refusal).toBe("blocked_by_policy");
    expect(outcomeOf(mark({ source: "blocked", refusal: "Server X said: no" })).refusal).toBeUndefined();
  });
});

describe("through the route", () => {
  let ticket: RunningTicketServer & { url: string };
  const open: OpenReal = async () => ({
    manager: new MCPClientManager({}, { lazyConnect: true }),
    config: { url: ticket.url },
  });
  const definition: MockDefinition = {
    tools: {
      lookup: {
        description: "Saved",
        answer: { from: "saved", cases: [{ when: { id: "1" }, result: { content: [{ type: "text", text: "one" }] } }] },
      },
      anything: {
        description: "Catch-all",
        answer: { from: "saved", cases: [{ result: { content: [{ type: "text", text: "any" }] } }] },
      },
    },
  };
  const httpDoor: MockDoor = {
    kind: "http",
    bearerToken: "ann-token",
    caller: { authMethod: "workos_api_key", workosUserId: "ann" },
    profile: { timeoutMs: 5_000 },
  };

  beforeEach(async () => {
    ticket = await startTicketHttp();
  });
  afterEach(async () => {
    await ticket.close();
  });

  const callBoth = async (reporter: MockOutcomeReporter) => {
    sink.report = (key, caller, m) => reporter.record(key as string, caller as OutcomeCaller, outcomeOf(m as MockCallMark));
    const client = await dialMock((request) =>
      serveMock(request, "mock1", httpDoor, {
        resolve: async () => resolvedMock({ definition, baseServerId: "real1" }),
        open,
        check: async () => ({ allowed: true }),
      }),
    );
    try {
      const saved = await client.executeTool("mock", "lookup", { id: "1", note: "private-argument" });
      await client.executeTool("mock", "anything", { id: "9" });
      const forwarded = await client.executeTool("mock", "echo", { message: "private-payload" });
      return { saved, forwarded };
    } finally {
      await client.disconnectAllServers();
    }
  };

  it("reports a saved answer with its case (and a catch-all as one) and a forward with its real tool, from the HTTP door, and no arguments or payloads", async () => {
    const { sent, fetchStub } = stubBackend();
    const reporter = new MockOutcomeReporter({ fetch: fetchStub });
    await callBoth(reporter);
    await reporter.flush();
    const outcomes = sent.flatMap((s) => s.body.outcomes);
    expect(outcomes).toEqual([
      { mockId: "mock1", version: 2, tool: "lookup", source: "saved", caseIndex: 0 },
      { mockId: "mock1", version: 2, tool: "anything", source: "saved", caseIndex: 0, catchAll: true },
      { mockId: "mock1", version: 2, tool: "echo", source: "forwarded", realTool: "echo" },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/private-argument|private-payload|real1/);
  });

  it("answers the call as usual when the report fails", async () => {
    const reporter = new MockOutcomeReporter({
      fetch: (async () => {
        throw new Error("backend unreachable");
      }) as typeof fetch,
    });
    const { saved, forwarded } = await callBoth(reporter);
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(JSON.stringify(saved)).toContain("one");
    expect(JSON.stringify(forwarded)).toContain("private-payload");
  });
});
