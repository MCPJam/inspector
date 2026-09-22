import { describe, expect, it, vi, beforeEach } from "vitest";

const evaluatePredicatesMock = vi.hoisted(() => vi.fn());
const buildIterationTranscriptMock = vi.hoisted(() => vi.fn());

vi.mock("@/shared/eval-matching", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/eval-matching")>(
      "@/shared/eval-matching",
    );
  return {
    ...actual,
    evaluatePredicates: evaluatePredicatesMock,
    buildIterationTranscript: buildIterationTranscriptMock,
  };
});

import {
  runPredicatesOnChatSession,
  type ChatSessionId,
} from "../run-predicates-on-chat-session";

type ConvexClientMock = {
  query: ReturnType<typeof vi.fn>;
  mutation: ReturnType<typeof vi.fn>;
  action: ReturnType<typeof vi.fn>;
};

/** The id `apiKeys:getCurrentUserIdQuery` resolves to for the mock bearer. */
const ACTOR_USER_ID = "jx7ca7xw1mhe1nw8sqcvfz7y8d8d3bg3";

function makeClient(): ConvexClientMock {
  return {
    query: vi.fn(async () => ACTOR_USER_ID),
    mutation: vi.fn(),
    action: vi.fn(),
  };
}

function basePredicates() {
  return [
    {
      type: "toolCalledAtLeastOnce" as const,
      toolName: "search",
    },
  ];
}

describe("runPredicatesOnChatSession", () => {
  beforeEach(() => {
    evaluatePredicatesMock.mockReset();
    buildIterationTranscriptMock.mockReset();
    buildIterationTranscriptMock.mockImplementation((input) => ({
      __transcript: true,
      input,
    }));
  });

  it("drives the full lifecycle: start → load → evaluate → complete", async () => {
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_1" };
      return undefined;
    });
    client.action.mockResolvedValue({
      traceVersion: 1,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolName: "search", input: { q: "hello" } },
          ],
        },
      ],
      spans: [],
    });
    const verdict = [{ predicate: basePredicates()[0], passed: true, reason: "ok" }];
    evaluatePredicatesMock.mockReturnValue(verdict);

    const result = await runPredicatesOnChatSession({
      convexClient: client as never,
      authHeader: "Bearer token",
      chatSessionId: "cs_1" as ChatSessionId,
      predicates: basePredicates(),
      setKind: "suite_defaults",
      setRef: "suite_42",
      setVersion: 3,
    });

    expect(result).toEqual({ checkRunId: "chk_1", results: verdict });

    // Mutation call order: startCheckRun, then completeCheckRun
    expect(client.mutation).toHaveBeenCalledTimes(2);
    expect(client.mutation.mock.calls[0]?.[0]).toContain("startCheckRun");
    const startArgs = client.mutation.mock.calls[0]?.[1] as {
      definitionSnapshot: Record<string, unknown>;
      runKind: string;
    };
    // The row must declare which grader wrote it. `source` cannot say (the
    // judge writes `on_demand` too), so the per-session Checks panel keys on
    // `runKind` to decide which rows it owns — drop this and every run from
    // this path renders under the judge's identity instead of its own.
    expect(startArgs.runKind).toBe("checks");
    expect(startArgs.definitionSnapshot).toMatchObject({
      setKind: "suite_defaults",
      setRef: "suite_42",
      setVersion: 3,
      predicates: basePredicates(),
    });
    expect(client.mutation.mock.calls[1]?.[0]).toContain("completeCheckRun");
    expect(client.mutation.mock.calls[1]?.[1]).toMatchObject({
      checkRunId: "chk_1",
      predicateResults: verdict,
    });

    // Action call: loadChatSessionEnvelopeAuthorized
    expect(client.action).toHaveBeenCalledTimes(1);
    expect(client.action.mock.calls[0]?.[0]).toContain(
      "loadChatSessionEnvelopeAuthorized",
    );

    // buildIterationTranscript got the messages + extracted toolCalls
    expect(buildIterationTranscriptMock).toHaveBeenCalledTimes(1);
    const transcriptInput = buildIterationTranscriptMock.mock.calls[0]?.[0] as {
      toolCalls: Array<{ toolName: string }>;
      trace: { messages: unknown[] };
      usage: undefined;
    };
    expect(transcriptInput.toolCalls).toEqual([
      { toolName: "search", arguments: { q: "hello" } },
    ]);
    expect(transcriptInput.usage).toBeUndefined();

    // evaluatePredicates was called with the transcript + predicates
    expect(evaluatePredicatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ __transcript: true }),
      basePredicates(),
    );
  });

  it("omits setRef / setVersion from definitionSnapshot when not supplied", async () => {
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_2" };
      return undefined;
    });
    client.action.mockResolvedValue({ messages: [], spans: [] });
    evaluatePredicatesMock.mockReturnValue([]);

    await runPredicatesOnChatSession({
      convexClient: client as never,
      authHeader: "Bearer token",
      chatSessionId: "cs_2" as ChatSessionId,
      predicates: basePredicates(),
      setKind: "ad_hoc",
    });

    const startArgs = client.mutation.mock.calls[0]?.[1] as {
      definitionSnapshot: Record<string, unknown>;
    };
    expect(startArgs.definitionSnapshot).toEqual({
      setKind: "ad_hoc",
      predicates: basePredicates(),
    });
    expect(startArgs.definitionSnapshot).not.toHaveProperty("setRef");
    expect(startArgs.definitionSnapshot).not.toHaveProperty("setVersion");
  });

  it("calls failCheckRun and rethrows when the envelope load fails", async () => {
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_3" };
      return undefined;
    });
    const authError = new Error("ChatSession not found or unauthorized");
    client.action.mockRejectedValue(authError);

    await expect(
      runPredicatesOnChatSession({
        convexClient: client as never,
        authHeader: "Bearer token",
        chatSessionId: "cs_3" as ChatSessionId,
        predicates: basePredicates(),
        setKind: "suite_defaults",
      }),
    ).rejects.toThrow("ChatSession not found or unauthorized");

    // start → fail (no complete)
    expect(client.mutation).toHaveBeenCalledTimes(2);
    expect(client.mutation.mock.calls[0]?.[0]).toContain("startCheckRun");
    expect(client.mutation.mock.calls[1]?.[0]).toContain("failCheckRun");
    expect(client.mutation.mock.calls[1]?.[1]).toMatchObject({
      checkRunId: "chk_3",
      error: "ChatSession not found or unauthorized",
    });

    // evaluatePredicates never ran
    expect(evaluatePredicatesMock).not.toHaveBeenCalled();
  });

  it("rethrows the primary error even if failCheckRun itself fails", async () => {
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_4" };
      if (name.endsWith(":failCheckRun"))
        throw new Error("secondary failure — should be swallowed");
      return undefined;
    });
    client.action.mockRejectedValue(new Error("primary failure"));

    await expect(
      runPredicatesOnChatSession({
        convexClient: client as never,
        authHeader: "Bearer token",
        chatSessionId: "cs_4" as ChatSessionId,
        predicates: basePredicates(),
        setKind: "ad_hoc",
      }),
    ).rejects.toThrow("primary failure");
  });

  it("extracts tool calls from inline toolCalls arrays as well as tool-call content parts", async () => {
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_5" };
      return undefined;
    });
    client.action.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: "text-only message",
          toolCalls: [{ toolName: "fetch", args: { url: "/x" } }],
        },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolName: "search", input: { q: "y" } },
          ],
        },
      ],
    });
    evaluatePredicatesMock.mockReturnValue([]);

    await runPredicatesOnChatSession({
      convexClient: client as never,
      authHeader: "Bearer token",
      chatSessionId: "cs_5" as ChatSessionId,
      predicates: basePredicates(),
      setKind: "ad_hoc",
    });

    const transcriptInput = buildIterationTranscriptMock.mock.calls[0]?.[0] as {
      toolCalls: Array<{ toolName: string; arguments: unknown }>;
    };
    expect(transcriptInput.toolCalls).toEqual([
      { toolName: "fetch", arguments: { url: "/x" } },
      { toolName: "search", arguments: { q: "y" } },
    ]);
  });

  it("deduplicates identical tool calls across messages", async () => {
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_6" };
      return undefined;
    });
    client.action.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolName: "search", input: { q: "x" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolName: "search", input: { q: "x" } },
          ],
        },
      ],
    });
    evaluatePredicatesMock.mockReturnValue([]);

    await runPredicatesOnChatSession({
      convexClient: client as never,
      authHeader: "Bearer token",
      chatSessionId: "cs_6" as ChatSessionId,
      predicates: basePredicates(),
      setKind: "ad_hoc",
    });

    const transcriptInput = buildIterationTranscriptMock.mock.calls[0]?.[0] as {
      toolCalls: unknown[];
    };
    expect(transcriptInput.toolCalls).toHaveLength(1);
  });

  it("attributes the run to the actor Convex resolves from the caller's bearer", async () => {
    // MJ-022 took `triggeredBy` out of the request body. `startCheckRun` is an
    // internal mutation that writes the argument verbatim with no fallback, so
    // simply not sending it would leave every row with no actor — no better as
    // evidence than an actor the caller chose. The id has to come from the same
    // authenticated client the rest of the lifecycle uses.
    const client = makeClient();
    client.mutation.mockImplementation(async (name: string) => {
      if (name.endsWith(":startCheckRun")) return { checkRunId: "chk_7" };
      return undefined;
    });
    client.action.mockResolvedValue({ messages: [], spans: [] });
    evaluatePredicatesMock.mockReturnValue([]);

    await runPredicatesOnChatSession({
      convexClient: client as never,
      authHeader: "Bearer token",
      chatSessionId: "cs_7" as ChatSessionId,
      predicates: basePredicates(),
      setKind: "ad_hoc",
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]?.[0]).toContain("getCurrentUserIdQuery");

    const startArgs = client.mutation.mock.calls[0]?.[1] as {
      triggeredBy?: string;
    };
    expect(startArgs.triggeredBy).toBe(ACTOR_USER_ID);
  });

  it("writes no check-run row when the acting user cannot be resolved", async () => {
    // Resolving the actor is the first call, deliberately. A row that exists
    // but cannot say who asked for it is the state this finding is about, so
    // failing before the insert is better than inserting without attribution.
    const client = makeClient();
    client.query.mockRejectedValue(new Error("Authentication required"));

    await expect(
      runPredicatesOnChatSession({
        convexClient: client as never,
        authHeader: "Bearer token",
        chatSessionId: "cs_8" as ChatSessionId,
        predicates: basePredicates(),
        setKind: "ad_hoc",
      }),
    ).rejects.toThrow("Authentication required");

    expect(client.mutation).not.toHaveBeenCalled();
    expect(client.action).not.toHaveBeenCalled();
  });
});
