import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The agent Playground surface (`chat-sessions.ts` + `chat-session-turn.ts`).
 *
 * These pin the properties that would fail QUIETLY — where the wrong answer
 * still looks like a valid response, so nothing downstream notices:
 *
 *   1. UNAVAILABLE IS NOT EMPTY. A transcript or span blob we could not read
 *      must report a flag, never a zero count or an empty array. An agent
 *      reading `spans: []` concludes the turn made no calls and debugs the
 *      wrong thing.
 *   2. INCREMENTAL BY DEFAULT. The trace read returns the LATEST turn, not the
 *      whole session. A regression to "everything" is invisible in a test
 *      fixture with one turn and expensive in production.
 *   3. NO DOUBLE SPEND. The lease is claimed BEFORE any model work: a replayed
 *      idempotencyKey must return without running a turn, and a concurrent
 *      turn must be refused rather than interleaved.
 *   4. CONFIG IS FIRST-TURN-ONLY. A continuation that resends config is
 *      refused. Without this a caller silently flips an approved `read_only`
 *      session to `auto` on turn two.
 *   5. NO GUESSED MODELS. A bare model id resolves to Ollama through the
 *      shared classifier, which on this surface would spend on the wrong rail
 *      and answer with the wrong model.
 *   6. CROSS-PROJECT SCOPING. `getSession` authorizes at the WORKSPACE level,
 *      which is wider than this surface, so a session in another project must
 *      be a 404 — the same answer as absence, never a 403.
 */

const { queryMock, mutationMock, fetchMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import chatSessions from "../chat-sessions.js";
import { v1OnError } from "../envelope.js";
import { __testing } from "../chat-session-turn.js";
import {
  boundPayload,
  joinToolCalls,
  projectMessages,
} from "../chat-session-payloads.js";

const PROJECT = "proj_a";
const OTHER_PROJECT = "proj_b";
const SESSION = "cs_1";

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", chatSessions);
  return app;
}

function call(method: string, path: string, body?: unknown) {
  return makeApp().request(path, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  _id: SESSION,
  chatSessionId: "runtime-uuid",
  projectId: PROJECT,
  origin: "api",
  modelId: "anthropic/claude-sonnet-5",
  version: 3,
  startedAt: 1_000,
  lastActivityAt: 2_000,
  messagesBlobUrl: "https://blob.test/messages",
  resumeConfig: {
    modelId: "anthropic/claude-sonnet-5",
    toolMode: "read_only",
    environmentId: "env_1",
  },
  ...overrides,
});

const traceRow = (
  promptIndex: number,
  overrides: Record<string, unknown> = {},
) => ({
  turnId: `turn_${promptIndex}`,
  promptIndex,
  startedAt: 1_000 + promptIndex,
  endedAt: 2_000 + promptIndex,
  finishReason: "stop",
  modelId: "anthropic/claude-sonnet-5",
  usage: { inputTokens: 10, outputTokens: 5 },
  spanCount: 2,
  spansBlobUrl: `https://blob.test/spans/${promptIndex}`,
  ...overrides,
});

/** Serve blob URLs from a map; anything unmapped answers 500. */
function serveBlobs(map: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url in map) {
      const value = map[url];
      if (value === "ERROR") {
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify(value), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  });
}

beforeEach(() => {
  queryMock.mockReset();
  mutationMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex-http.test";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Detail read ─────────────────────────────────────────────────────────────

describe("GET /v1/chat-sessions/:id", () => {
  it("answers 404 — not 403 — for a session in another project", async () => {
    queryMock.mockResolvedValue(sessionRow({ projectId: OTHER_PROJECT }));
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}?projectId=${PROJECT}`,
    );
    expect(response.status).toBe(404);
    // A 403 here would confirm the session exists, turning the read into an
    // existence oracle for projects the caller cannot see.
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it("reports an unreadable transcript rather than an empty conversation", async () => {
    queryMock.mockResolvedValue(sessionRow());
    serveBlobs({ "https://blob.test/messages": "ERROR" });
    const response = await call("GET", `/api/v1/chat-sessions/${SESSION}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.transcriptUnavailable).toBe(true);
    // `null`, never 0 — zero is a claim that nothing was said.
    expect(body.messageCount).toBeNull();
    expect(body.messages).toEqual([]);
  });

  it("indexes messages ABSOLUTELY so trace spans can join to them", async () => {
    queryMock.mockResolvedValue(sessionRow());
    serveBlobs({
      "https://blob.test/messages": [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}?afterMessageIndex=1&limit=1`,
    );
    const body = await response.json();
    expect(body.messageCount).toBe(3);
    // Index 1, not index 0: renumbering per page would break the one join
    // this read exists to enable.
    expect(body.messages).toEqual([
      { index: 1, role: "assistant", content: "b" },
    ]);
    expect(body.nextMessageIndex).toBe(2);
  });

  it("rejects a non-integer window rather than silently defaulting", async () => {
    queryMock.mockResolvedValue(sessionRow());
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}?afterMessageIndex=oops`,
    );
    expect(response.status).toBe(400);
  });
});

// ── Trace read ──────────────────────────────────────────────────────────────

describe("GET /v1/chat-sessions/:id/trace", () => {
  it("returns the LATEST turn by default, not the whole session", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "chatSessions:getSession"
        ? sessionRow()
        : [traceRow(0), traceRow(1), traceRow(2)],
    );
    serveBlobs({
      "https://blob.test/spans/2": [{ kind: "llm" }, { kind: "tool" }],
    });
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace`,
    );
    const body = await response.json();
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].promptIndex).toBe(2);
    expect(body.turnCount).toBe(3);
    expect(body.latestPromptIndex).toBe(2);
    // Only the selected turn's blob is fetched — the whole point of paging.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pages older turns forward with afterPromptIndex", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "chatSessions:getSession"
        ? sessionRow()
        : [traceRow(0), traceRow(1), traceRow(2)],
    );
    serveBlobs({
      "https://blob.test/spans/1": [{ kind: "llm" }],
      "https://blob.test/spans/2": [{ kind: "llm" }],
    });
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace?afterPromptIndex=0&limit=5`,
    );
    const body = await response.json();
    expect(
      body.turns.map((t: { promptIndex: number }) => t.promptIndex),
    ).toEqual([1, 2]);
  });

  it("serves cheap summaries with includeSpans=false", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "chatSessions:getSession" ? sessionRow() : [traceRow(0)],
    );
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace?includeSpans=false`,
    );
    const body = await response.json();
    expect(body.turns[0].spanCount).toBe(2);
    expect(body.turns[0].spans).toBeUndefined();
    // No blob fetched at all — that is what makes the summary cheap.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags unreadable spans instead of returning an empty span list", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "chatSessions:getSession" ? sessionRow() : [traceRow(0)],
    );
    serveBlobs({ "https://blob.test/spans/0": "ERROR" });
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace`,
    );
    const body = await response.json();
    expect(body.turns[0].spansUnavailable).toBe(true);
    // An empty array would read as "this turn made no calls", which is the
    // opposite conclusion.
    expect(body.turns[0].spans).toBeUndefined();
  });

  it("flags a span blob shorter than its recorded count", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "chatSessions:getSession" ? sessionRow() : [traceRow(0)],
    );
    serveBlobs({ "https://blob.test/spans/0": [{ kind: "llm" }] });
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace`,
    );
    const body = await response.json();
    expect(body.turns[0].spansTruncated).toBe(true);
  });

  it("refuses two selectors at once rather than picking one", async () => {
    queryMock.mockResolvedValue(sessionRow());
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace?turnId=turn_0&afterPromptIndex=0`,
    );
    expect(response.status).toBe(400);
  });

  it("404s an unknown turnId", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "chatSessions:getSession" ? sessionRow() : [traceRow(0)],
    );
    const response = await call(
      "GET",
      `/api/v1/chat-sessions/${SESSION}/trace?turnId=nope`,
    );
    expect(response.status).toBe(404);
  });
});

// ── Turn route: everything that must happen BEFORE a model call ─────────────

describe("POST /v1/chat-sessions/messages", () => {
  const turn = (body: Record<string, unknown>) =>
    call("POST", "/api/v1/chat-sessions/messages", body);

  it("refuses config on a continuation, naming the offending fields", async () => {
    queryMock.mockResolvedValue(sessionRow());
    const response = await turn({
      sessionId: SESSION,
      idempotencyKey: "k1",
      message: "hi",
      toolMode: "auto",
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.details.reason).toBe("CONFIG_ON_CONTINUATION");
    // Naming the field is the point: "you may not send config" alone leaves
    // the caller to bisect their own payload.
    expect(body.details.fields).toEqual(["toolMode"]);
    // Nothing was claimed, so nothing needs releasing.
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("ACCEPTS per-turn bounds on a continuation", async () => {
    // These are not session config, and refusing them was actively harmful:
    // a first turn could narrow to two tools, every continuation would be
    // rejected for restating the narrowing, and the turn would then run
    // against the full set — the restriction evaporating while the API
    // insisted the caller must not repeat it.
    queryMock.mockResolvedValue(sessionRow());
    mutationMock.mockResolvedValue({
      status: "in_progress",
      retryAfterMs: 10,
    });
    serveBlobs({ "https://blob.test/messages": [] });
    const response = await turn({
      sessionId: SESSION,
      idempotencyKey: "k9",
      message: "hi",
      allowedTools: ["search"],
      allowedServerIds: ["srv_1"],
      maxToolCalls: 1,
      maxSteps: 3,
    });
    // Reached the lease rather than being refused at the boundary.
    expect(response.status).toBe(409);
    expect((await response.json()).details.reason).toBe("TURN_IN_PROGRESS");
  });

  it("refuses to append to a session this surface did not create", async () => {
    queryMock.mockResolvedValue(sessionRow({ origin: "playground" }));
    const response = await turn({
      sessionId: SESSION,
      idempotencyKey: "k1",
      message: "hi",
    });
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.details.reason).toBe("CONTINUATION_NOT_ALLOWED");
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("replays a completed idempotencyKey WITHOUT running a turn", async () => {
    queryMock.mockResolvedValue(sessionRow());
    mutationMock.mockResolvedValue({
      status: "completed",
      turnId: "turn_7",
      sessionId: SESSION,
    });
    serveBlobs({ "https://blob.test/messages": [] });
    const response = await turn({
      sessionId: SESSION,
      idempotencyKey: "same-key",
      message: "hi",
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.persisted.outcome).toBe("duplicate");
    expect(body.turnId).toBe("turn_7");
    expect(body.replay).toBe(true);
    // A CONTINUATION never sends a project — this one comes off the session
    // row. It is the only thing in the response that says where the session
    // lives, and a caller composing the session's app URL has nothing else
    // to read it from.
    expect(body.projectId).toBe(PROJECT);
    // The lease claim is the ONLY mutation: no second turn, no second bill.
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]![0]).toBe("chatSessions:claimTurnLease");
  });

  it("refuses a concurrent turn on one session with a retry hint", async () => {
    queryMock.mockResolvedValue(sessionRow());
    mutationMock.mockResolvedValue({
      status: "in_progress",
      retryAfterMs: 4_200,
    });
    serveBlobs({ "https://blob.test/messages": [] });
    const response = await turn({
      sessionId: SESSION,
      idempotencyKey: "k2",
      message: "hi",
    });
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.details.reason).toBe("TURN_IN_PROGRESS");
    expect(body.details.retryAfterMs).toBe(4_200);
  });

  it("rejects a bare model id instead of resolving it to Ollama", async () => {
    const response = await turn({
      projectId: PROJECT,
      idempotencyKey: "k3",
      message: "hi",
      modelId: "claude-sonnet-5",
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.details.reason).toBe("MODEL_AMBIGUOUS");
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("requires a project and a model to start a session", async () => {
    expect((await turn({ idempotencyKey: "k4", message: "hi" })).status).toBe(
      400,
    );
    expect(
      (await turn({ projectId: PROJECT, idempotencyKey: "k4", message: "hi" }))
        .status,
    ).toBe(400);
  });

  it("refuses a target named two ways at once", async () => {
    const response = await turn({
      projectId: PROJECT,
      idempotencyKey: "k5",
      message: "hi",
      modelId: "anthropic/claude-sonnet-5",
      environmentId: "env_1",
      serverIds: ["srv_1"],
    });
    expect(response.status).toBe(400);
  });

  it("requires an idempotencyKey — there is no unsafe fallback", async () => {
    const response = await turn({
      projectId: PROJECT,
      message: "hi",
      modelId: "anthropic/claude-sonnet-5",
      serverIds: ["srv_1"],
    });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown field rather than silently dropping it", async () => {
    const response = await turn({
      projectId: PROJECT,
      idempotencyKey: "k6",
      message: "hi",
      modelId: "anthropic/claude-sonnet-5",
      serverIds: ["srv_1"],
      // A knob we do not support. A non-strict body would 200 and ignore it,
      // which is the silent-no-op class this codebase has been bitten by.
      temperatureCelsius: 20,
    });
    expect(response.status).toBe(400);
  });
});

// ── Model-id policy ─────────────────────────────────────────────────────────

describe("assertUnambiguousModelId", () => {
  const { assertUnambiguousModelId } = __testing;

  it("accepts every shape whose provider is explicit", () => {
    for (const id of [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5",
      "ollama/llama3",
      "custom:acme:my-model",
    ]) {
      expect(() => assertUnambiguousModelId(id)).not.toThrow();
    }
  });

  it("rejects ids whose provider would have to be guessed", () => {
    for (const id of ["claude-sonnet-5", "llama3", "not-a-provider/x"]) {
      expect(() => assertUnambiguousModelId(id)).toThrow();
    }
  });
});

// ── Tool policy ─────────────────────────────────────────────────────────────

describe("computeExcludedToolNames", () => {
  const { computeExcludedToolNames } = __testing;
  const manager = (tools: unknown[]) =>
    ({ getTools: async () => tools } as never);

  it("excludes UNANNOTATED tools under read_only", async () => {
    const result = await computeExcludedToolNames(
      manager([
        { name: "search", annotations: { readOnlyHint: true } },
        { name: "delete_all", annotations: { readOnlyHint: false } },
        // No annotations at all. MCP's default for an absent hint is "assume
        // it mutates" — treating silence as consent would make the mode
        // meaningless against exactly the servers least likely to annotate.
        { name: "mystery" },
      ]),
      ["srv"],
      { toolMode: "read_only" },
    );
    expect(result.excluded.sort()).toEqual(["delete_all", "mystery"]);
    expect(result.advertised).toBe(1);
  });

  it("advertises everything under auto, minus an explicit allowlist", async () => {
    const tools = [
      { name: "search", annotations: { readOnlyHint: true } },
      { name: "delete_all" },
    ];
    expect(
      (
        await computeExcludedToolNames(manager(tools), ["srv"], {
          toolMode: "auto",
        })
      ).excluded,
    ).toEqual([]);
    expect(
      (
        await computeExcludedToolNames(manager(tools), ["srv"], {
          toolMode: "auto",
          allowedTools: ["search"],
        })
      ).excluded,
    ).toEqual(["delete_all"]);
  });

  it("fails CLOSED when the target's tools cannot be listed", async () => {
    // Failing open would advertise every tool on a `read_only` turn — exactly
    // the outcome the mode exists to prevent.
    await expect(
      computeExcludedToolNames(
        { getTools: async () => Promise.reject(new Error("boom")) } as never,
        ["srv"],
        { toolMode: "read_only" },
      ),
    ).rejects.toThrow(/tool policy cannot be applied/);
  });
});

describe("unappliedBuiltInToolIds", () => {
  const { unappliedBuiltInToolIds } = __testing;

  // This surface does not wire built-in tools — `bash` and `web_search` are
  // applied in routes/web/chat-v2.ts, not here. Observed on a real turn: a
  // client with a computer attached and `builtInToolIds: ["bash"]` ran with
  // the MCP server's tools alone and the model answered "I don't actually
  // have a bash tool", which a caller cannot tell apart from the model
  // declining to use one. Naming it is the fix; refusing the turn is not.
  it("names the built-ins a client asked for", () => {
    expect(unappliedBuiltInToolIds({ builtInToolIds: ["bash"] })).toEqual([
      "bash",
    ]);
    expect(
      unappliedBuiltInToolIds({ builtInToolIds: ["bash", "web_search"] }),
    ).toEqual(["bash", "web_search"]);
  });

  // A client that asked for nothing must not grow a field in the response.
  it("is empty for a client that configures none", () => {
    expect(unappliedBuiltInToolIds({})).toEqual([]);
    expect(unappliedBuiltInToolIds({ builtInToolIds: [] })).toEqual([]);
    expect(unappliedBuiltInToolIds(undefined)).toEqual([]);
  });

  // The config blob is opaque to this route, so it is not assumed well-formed.
  it("ignores a malformed builtInToolIds", () => {
    expect(unappliedBuiltInToolIds({ builtInToolIds: "bash" })).toEqual([]);
    expect(unappliedBuiltInToolIds({ builtInToolIds: [1, "", null] })).toEqual(
      [],
    );
  });
});

// ── Target narrowing ────────────────────────────────────────────────────────

describe("allowedServerIds narrowing", () => {
  const { narrowTarget } = __testing;

  it("treats an EMPTY allowlist as none, not as omitted", () => {
    // Reading `[]` as "no filter" would run the turn against every server in
    // the target — the opposite of what the field says, and unsafe under
    // toolMode:"auto" where it enables side effects on servers the caller just
    // tried to exclude.
    expect(narrowTarget({ serverIds: ["a", "b"] }, []).selected).toHaveLength(
      0,
    );
    // Omitted is the "no filter" case, and stays that way.
    expect(
      narrowTarget({ serverIds: ["a", "b"] }, undefined).selected,
    ).toHaveLength(2);
  });

  it("keeps names paired with their own ids", () => {
    // `createManualHostedConnection` pairs ids and names POSITIONALLY, so
    // filtering ids while passing the original name array relabels every
    // server after the first gap: picking only "b" would give it "Server A"'s
    // name, and a connection failure would then blame the wrong server.
    const result = narrowTarget(
      { serverIds: ["a", "b", "c"], serverNames: ["A", "B", "C"] },
      ["b", "c"],
    );
    expect(result.selected.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(result.names).toEqual(["B", "C"]);
  });

  it("drops names entirely rather than half-aligning them", () => {
    // A partially-populated name array is worse than none: the manager falls
    // back to showing the id when a name is absent, but a MISALIGNED name is
    // confidently wrong.
    const result = narrowTarget(
      { serverIds: ["a", "b"], serverNames: ["A"] },
      undefined,
    );
    expect(result.names).toBeUndefined();
  });
});

// ── Lease release ───────────────────────────────────────────────────────────

describe("shouldReleaseLease", () => {
  const { shouldReleaseLease } = __testing;

  it("KEEPS the lease once the engine was entered, even on timeout", () => {
    // The bug this pins: a turn that timed out after tool calls already ran
    // used to hand its lease back, so the caller's retry with the required
    // stable idempotencyKey claimed a fresh one, billed the model again, and
    // repeated the side effects. The TTL — not a release — is what settles a
    // turn that may have spent.
    expect(
      shouldReleaseLease({
        leaseTurnId: "t1",
        leaseSettled: false,
        modelCallStarted: true,
      }),
    ).toBe(false);
  });

  it("releases a lease whose turn never reached the engine", () => {
    // Bad target, dead server, unresolvable model. Nothing spent, so holding
    // the session for the full TTL would be a self-inflicted outage on the
    // failure path that most needs to stay usable.
    expect(
      shouldReleaseLease({
        leaseTurnId: "t1",
        leaseSettled: false,
        modelCallStarted: false,
      }),
    ).toBe(true);
  });

  it("leaves a settled lease alone", () => {
    // The ingest completed it inside its own mutation.
    expect(
      shouldReleaseLease({
        leaseTurnId: "t1",
        leaseSettled: true,
        modelCallStarted: true,
      }),
    ).toBe(false);
  });

  it("is a no-op when nothing was ever claimed", () => {
    expect(
      shouldReleaseLease({
        leaseTurnId: undefined,
        leaseSettled: false,
        modelCallStarted: false,
      }),
    ).toBe(false);
  });
});

// ── Tool-call budget ────────────────────────────────────────────────────────

describe("maxToolCalls", () => {
  const { capToolCalls, computeExcludedToolNames } = __testing;
  const manager = (tools: unknown[]) =>
    ({ getTools: async () => tools } as never);

  it("treats an empty allowedTools the same as a zero cap", () => {
    // Two ways of saying "no tools". Letting them diverge would make one of
    // them the subtly broken one.
    const { wantsNoTools } = __testing;
    expect(wantsNoTools({ maxToolCalls: 0 })).toBe(true);
    expect(wantsNoTools({ allowedTools: [] })).toBe(true);
    expect(wantsNoTools({ allowedTools: ["search"] })).toBe(false);
    expect(wantsNoTools({})).toBe(false);
  });

  it("advertises NOTHING when the cap is zero", async () => {
    // Enforcing zero by refusing at dispatch would be worse than useless: the
    // tool has already cost prompt tokens and shaped the model's plan, and the
    // turn answers "I tried to call a tool and was blocked" instead of
    // answering the question.
    const result = await computeExcludedToolNames(
      manager([
        { name: "search", annotations: { readOnlyHint: true } },
        { name: "fetch", annotations: { readOnlyHint: true } },
      ]),
      ["srv"],
      { toolMode: "read_only", excludeAll: true },
    );
    expect(result.excluded.sort()).toEqual(["fetch", "search"]);
    expect(result.advertised).toBe(0);
  });

  it("caps CALLS, not steps — including parallel calls in one step", async () => {
    // The bug this pins: a step budget bounds round trips, and one step can
    // emit several tool calls, so "at most 2" could execute five.
    const executed: string[] = [];
    const make = (name: string) => ({
      execute: async () => {
        executed.push(name);
        return { ok: true };
      },
    });
    const capped = capToolCalls(
      { a: make("a"), b: make("b") } as never,
      2,
    ) as unknown as Record<
      string,
      { execute: (...a: unknown[]) => Promise<unknown> }
    >;

    // Four calls issued together, as one step's parallel fan-out would.
    const results = await Promise.all([
      capped.a!.execute({}),
      capped.b!.execute({}),
      capped.a!.execute({}),
      capped.b!.execute({}),
    ]);

    expect(executed).toHaveLength(2);
    const refused = results.filter(
      (r) => (r as { isError?: boolean }).isError === true,
    );
    expect(refused).toHaveLength(2);
    // The refusal is RETURNED, not thrown: a throw would surface as an engine
    // failure and lose the turn's answer entirely.
    expect(
      JSON.stringify((refused[0] as { content: unknown }).content),
    ).toMatch(/budget/);
  });

  it("passes client-fulfilled entries through untouched", async () => {
    // No `execute` means the server never dispatches it, so there is nothing
    // to count — and inventing one would defeat the engine's no-execute gates.
    const entry = { description: "client tool" };
    const capped = capToolCalls(
      { ui_x: entry } as never,
      1,
    ) as unknown as Record<string, unknown>;
    expect(capped.ui_x).toBe(entry);
  });
});

// ── Payload economics ───────────────────────────────────────────────────────

describe("payload bounding", () => {
  it("drops protocol annotations, not caller data", () => {
    const { value } = boundPayload({
      city: "SF",
      _meta: { progressToken: 1 },
      $schema: "http://example",
      nested: { $ref: "x", keep: true },
    });
    expect(value).toEqual({ city: "SF", nested: { keep: true } });
  });

  it("announces truncation instead of silently shortening", () => {
    const result = boundPayload({ blob: "x".repeat(50_000) });
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe("string");
  });

  it("contains a cycle at the depth cap rather than failing the turn", () => {
    // The depth cap, not the serializer catch, is what stops this: a cyclic
    // tool result must never take down a turn that already ran and already
    // spent, and it must not need `JSON.stringify` to throw first.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let result!: ReturnType<typeof boundPayload>;
    expect(() => {
      result = boundPayload({ a: { b: { c: cyclic } } });
    }).not.toThrow();
    expect(JSON.stringify(result.value)).toContain("max depth");
  });

  it("renders a bigint instead of throwing on it", () => {
    // `JSON.stringify` THROWS on bigint, which would turn one odd tool result
    // into a 500 for the whole turn.
    expect(boundPayload({ n: 10n }).value).toEqual({ n: "10" });
  });

  it("reports a tool call with no result as an error, not as missing", () => {
    const joined = joinToolCalls(
      [{ toolCallId: "t1", toolName: "search", input: { q: "x" } }],
      [],
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.status).toBe("error");
    // "No result reached us" and "the tool returned an error" lead an agent to
    // different next moves, so the message says which one this is.
    expect(joined[0]!.errorMessage).toMatch(/No tool result/);
  });

  it("unwraps the AI SDK output envelope and flags error tags", () => {
    const joined = joinToolCalls(
      [
        { toolCallId: "t1", toolName: "ok", input: {} },
        { toolCallId: "t2", toolName: "bad", input: {} },
      ],
      [
        { toolCallId: "t1", output: { type: "json", value: { temp: 12 } } },
        { toolCallId: "t2", output: { type: "error-json", value: "nope" } },
      ],
    );
    expect(joined[0]!.output).toEqual({ temp: 12 });
    expect(joined[0]!.status).toBe("ok");
    expect(joined[1]!.status).toBe("error");
  });

  it("keeps absolute message indices when projecting a page", () => {
    expect(projectMessages([{ role: "user", content: "c" }], 5)).toEqual([
      { index: 5, role: "user", content: "c" },
    ]);
  });
});
