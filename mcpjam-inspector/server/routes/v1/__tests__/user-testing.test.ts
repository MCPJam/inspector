import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The user-testing surface (`user-testing.ts`) and the publish fix in
 * `scenarios.ts`.
 *
 * These pin the four things that would fail quietly and expose something:
 *
 *   1. ATOMIC PUBLISH. `chatboxes:publishEnvironmentChatbox` accepts `name`,
 *      `description` and `mode` at create time precisely so publishing a
 *      restricted scenario is ONE transaction. The route used to drop them,
 *      which meant a caller asking for `invited_only` got a scenario live in
 *      the default mode and believed otherwise.
 *   2. SINGLE-CONCERN UPDATE. Identity and exposure are separate mutations
 *      upstream. A mixed request would have to chain them, and a failure
 *      between the two leaves the scenario half-updated on the half that
 *      decides who can reach it.
 *   3. NO BLOB URL EVER. `chatSessions:getSession` returns a direct handle on
 *      the stored conversation with no further authorization. Returning it
 *      would turn one authorized read into an unbounded, unrevocable one.
 *   4. CROSS-SCENARIO SCOPING. Every `chatboxes:*` mutation takes a chatbox id
 *      alone, and `getSession` authorizes broadly enough that a project member
 *      can read sessions the scenario in the path does not own.
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

import userTesting from "../user-testing.js";
import scenarios from "../scenarios.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";
const OTHER_PROJECT = "proj_b";
const SCENARIO = "cb_1";
const BASE = `/api/v1/projects/${PROJECT}/user-testing/scenarios/${SCENARIO}`;

function makeApp(router: Parameters<Hono["route"]>[1]) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", router);
  return app;
}

function call(
  router: Parameters<Hono["route"]>[1],
  method: string,
  path: string,
  body?: unknown
) {
  return makeApp(router).request(path, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}

// Mirrors the `getChatbox` SETTINGS ENVELOPE, which deliberately carries no
// `accessVersion` — that field only travels on the publish/rebind projection.
// A stub that invented one here would let the routes appear to serve a value
// the real upstream never sends.
const scenarioRow = (projectId = PROJECT) => ({
  _id: SCENARIO,
  projectId,
  workspaceId: "ws_1",
  name: "Checkout",
  mode: "invited_only",
});

/**
 * Queries answered BY NAME, not by call order.
 *
 * `vi.clearAllMocks()` drains recorded calls but not queued
 * `mockResolvedValueOnce` implementations, so an order-driven stub leaks its
 * unconsumed queue into the next test — which is how two of these tests
 * initially failed with each other's answers. Keying on the Convex function
 * name is also simply more readable: a test says what `getSession` returns,
 * not what "the second query" returns.
 */
function answerQueries(answers: Record<string, unknown>) {
  queryMock.mockImplementation((name: string) => {
    // Matched on the FUNCTION NAME exactly — the segment after the colon in
    // `module:function` — not as a substring. Substring matching would let
    // `getSession` answer a `getSessionScorecard` read as soon as one existed,
    // and the test would keep passing while asserting the wrong thing.
    const fn = String(name).split(":").pop() ?? "";
    if (Object.prototype.hasOwnProperty.call(answers, fn)) {
      return Promise.resolve(answers[fn]);
    }
    return Promise.resolve(null);
  });
}

/**
 * A body that exceeds the route's 8MB ceiling, delivered in chunks.
 *
 * A stream rather than one big string so the assertion is about bytes
 * ARRIVING: the route is supposed to stop mid-transfer, which a fully
 * materialized body cannot demonstrate.
 *
 * VALID JSON, and that is the whole point. An earlier version streamed 16MB of
 * `x`, which a route that only checked `content-length` would have parsed,
 * thrown a SyntaxError on, and reported as `transcriptUnavailable` — the same
 * answer the fixed route gives, so the test passed on the bug it was written to
 * pin. Being parseable is what makes the two outcomes differ: an unbounded read
 * SUCCEEDS here and returns a real `messageCount`, so only a route that stops
 * counting bytes can refuse it.
 */
const OVERSIZED_MESSAGE_COUNT = 16;

function oversizedTranscriptStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Each message is ~1MB, so the array passes the 8MB ceiling partway through
  // and the remaining chunks are never read.
  const message = `{"role":"user","content":"${"x".repeat(1024 * 1024)}"}`;
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === 0) controller.enqueue(encoder.encode("["));
      if (sent >= OVERSIZED_MESSAGE_COUNT) {
        controller.enqueue(encoder.encode("]"));
        controller.close();
        return;
      }
      const separator = sent === 0 ? "" : ",";
      sent += 1;
      controller.enqueue(encoder.encode(separator + message));
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  vi.stubGlobal("fetch", fetchMock);
  queryMock.mockReset();
  answerQueries({ getChatbox: scenarioRow() });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("publish (scenarios.ts)", () => {
  it("forwards name/description/mode in the SAME mutation call", async () => {
    // The whole point of the backend accepting these atomically: without them
    // "publish restricted" is two operations, and between them the scenario is
    // live in the default mode.
    answerQueries({
      getEnvironment: { environmentId: "env_1", projectId: PROJECT },
    });
    mutationMock.mockResolvedValue({
      chatboxId: SCENARIO,
      environmentId: "env_1",
      name: "Checkout",
      mode: "invited_only",
      accessVersion: 1,
      link: null,
      created: true,
    });
    const res = await call(
      scenarios,
      "PUT",
      `/api/v1/projects/${PROJECT}/environments/env_1/scenario`,
      {
        name: "Checkout",
        // Sent because the test claims all THREE travel together. Without it a
        // regression that dropped `description` would leave this green.
        description: "Checkout flow, mobile web",
        mode: "invited_only",
      }
    );
    expect(res.status).toBe(201);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const [, args] = mutationMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(args).toMatchObject({
      environmentId: "env_1",
      name: "Checkout",
      description: "Checkout flow, mobile web",
      mode: "invited_only",
    });
  });

  it("omits an absent description rather than sending an empty one", () => {
    // `""` and absent are different upstream: one blanks a description the
    // scenario may already have, the other leaves it alone.
    answerQueries({
      getEnvironment: { environmentId: "env_1", projectId: PROJECT },
    });
    mutationMock.mockResolvedValue({
      chatboxId: SCENARIO,
      environmentId: "env_1",
      name: "Checkout",
      mode: "invited_only",
      accessVersion: 1,
      link: null,
      created: true,
    });
    return call(
      scenarios,
      "PUT",
      `/api/v1/projects/${PROJECT}/environments/env_1/scenario`,
      { name: "Checkout", mode: "invited_only" }
    ).then(() => {
      const [, args] = mutationMock.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(args).not.toHaveProperty("description");
    });
  });

  it("says so when a republish DISCARDED the overrides", async () => {
    // They are create-time only upstream. Silence would let a caller who asked
    // for `invited_only` conclude the link is restricted when it is not.
    answerQueries({
      getEnvironment: { environmentId: "env_1", projectId: PROJECT },
    });
    mutationMock.mockResolvedValue({
      chatboxId: SCENARIO,
      environmentId: "env_1",
      name: "Existing",
      mode: "anyone_with_link",
      accessVersion: 4,
      link: "https://app.mcpjam.com/s/x",
      created: false,
    });
    const res = await call(
      scenarios,
      "PUT",
      `/api/v1/projects/${PROJECT}/environments/env_1/scenario`,
      { mode: "invited_only" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.overridesIgnored).toBe(true);
    // And the mode reported is the REAL one, not the one that was asked for.
    expect(body.mode).toBe("anyone_with_link");
  });

  it("rejects a body that is not JSON", async () => {
    answerQueries({
      getEnvironment: { environmentId: "env_1", projectId: PROJECT },
    });
    const res = await makeApp(scenarios).request(
      `/api/v1/projects/${PROJECT}/environments/env_1/scenario`,
      {
        method: "PUT",
        body: "not json",
        headers: { "content-type": "application/json" },
      }
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown field and an invalid mode", async () => {
    // `strictObject`, so a typo'd key is a 400 rather than a silently dropped
    // intention — on a route where the dropped intention could be `mode`.
    answerQueries({
      getEnvironment: { environmentId: "env_1", projectId: PROJECT },
    });
    for (const body of [{ nmae: "typo" }, { mode: "public" }]) {
      const res = await call(
        scenarios,
        "PUT",
        `/api/v1/projects/${PROJECT}/environments/env_1/scenario`,
        body
      );
      expect(res.status).toBe(400);
    }
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("still publishes with no body at all", async () => {
    answerQueries({
      getEnvironment: { environmentId: "env_1", projectId: PROJECT },
    });
    mutationMock.mockResolvedValue({
      chatboxId: SCENARIO,
      environmentId: "env_1",
      name: "Checkout",
      mode: "project_members",
      accessVersion: 1,
      link: null,
      created: true,
    });
    const res = await call(
      scenarios,
      "PUT",
      `/api/v1/projects/${PROJECT}/environments/env_1/scenario`
    );
    expect(res.status).toBe(201);
  });
});

describe("scenario update", () => {
  it("refuses a body that mixes identity and exposure", async () => {
    // Two mutations upstream. Chaining them means a failure between the two
    // leaves the scenario half-updated on the half that decides access.
    const res = await call(userTesting, "PATCH", BASE, {
      name: "Renamed",
      mode: "anyone_with_link",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/on its own/i);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("routes a mode change to setChatboxMode and nothing else", async () => {
    mutationMock.mockResolvedValue(null);
    const res = await call(userTesting, "PATCH", BASE, {
      mode: "invited_only",
    });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[0]).toBe("chatboxes:setChatboxMode");
    // No `accessVersion` in the response. The mutation bumps it upstream, but
    // the settings envelope the route re-reads does not carry the value — an
    // always-null field would document a revocation signal never delivered.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("accessVersion");
  });

  it("routes a rename to updateChatbox and nothing else", async () => {
    mutationMock.mockResolvedValue(null);
    await call(userTesting, "PATCH", BASE, { name: "Renamed" });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[0]).toBe("chatboxes:updateChatbox");
  });

  it("404s a scenario that resolves into another project", async () => {
    answerQueries({ getChatbox: scenarioRow(OTHER_PROJECT) });
    const res = await call(userTesting, "PATCH", BASE, { name: "Renamed" });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("404s a scenario that does not resolve at all", async () => {
    // A separate branch from the project mismatch above: this one guards the
    // absent row, and a regression that dereferenced it would pass the other.
    answerQueries({});
    const res = await call(userTesting, "PATCH", BASE, { name: "Renamed" });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("session transcript", () => {
  it("NEVER returns the stored blob URL", async () => {
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/secret-blob",
      },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ role: "user", content: "hello" }]), {
        status: 200,
      })
    );
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    const raw = await res.text();
    // A direct handle with no further authorization: handing it out turns one
    // authorized read into an unbounded, shareable one.
    expect(raw).not.toContain("secret-blob");
    expect(raw).not.toContain("messagesBlobUrl");
    expect(JSON.parse(raw)).toMatchObject({
      messages: [{ role: "user", text: "hello" }],
    });
  });

  it("404s a session that belongs to a DIFFERENT scenario", async () => {
    // `getSession` authorizes broadly — a project member can read swarm
    // sessions — so without this check any session in the project would be
    // readable through a scenario's URL.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: { chatboxId: "cb_other", chatSessionId: "cs_1" },
    });
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    expect(res.status).toBe(404);
  });

  it("pages long transcripts instead of returning the whole thing", async () => {
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/blob",
      },
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          Array.from({ length: 120 }, (_, index) => ({
            role: "user",
            content: `m${index}`,
          }))
        ),
        { status: 200 }
      )
    );
    const res = await call(
      userTesting,
      "GET",
      `${BASE}/sessions/sess_1?limit=50`
    );
    const body = (await res.json()) as {
      messages: unknown[];
      messageCount: number;
      nextCursor?: string;
    };
    expect(body.messages).toHaveLength(50);
    expect(body.messageCount).toBe(120);
    expect(body.nextCursor).toBe("50");
  });

  it("400s an unparseable cursor instead of re-serving page one", async () => {
    // Coercing to 0 handed back already-seen messages with a fresh cursor and
    // no signal, so a paging caller could act on the same conversation twice.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: { chatboxId: SCENARIO, chatSessionId: "cs_1" },
    });
    const res = await call(
      userTesting,
      "GET",
      `${BASE}/sessions/sess_1?cursor=oops`
    );
    expect(res.status).toBe(400);
  });

  it("reports a null messageCount when the transcript is unreadable", async () => {
    // 0 is a claim the visitor said nothing — the opposite of what an
    // unreadable blob means, and a consumer reading only the count acts on it.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/blob",
      },
    });
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    const body = (await res.json()) as { messageCount: number | null };
    expect(body.messageCount).toBeNull();
  });

  it("refuses to buffer a transcript past the size ceiling", async () => {
    // The timeout caps latency, not bytes. Without this the whole conversation
    // lands in memory on a request thread, once per concurrent reader.
    //
    // The body really is oversized rather than merely CLAIMING to be: an
    // earlier version of this test set a 64MB `content-length` on a two-byte
    // body, which passed against a route that never read past the header — so
    // it would have passed against the bug as well.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/huge",
      },
    });
    fetchMock.mockResolvedValue(
      new Response(oversizedTranscriptStream(), {
        status: 200,
        headers: { "content-length": String(64 * 1024 * 1024) },
      })
    );
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    const body = (await res.json()) as { transcriptUnavailable?: boolean };
    expect(body.transcriptUnavailable).toBe(true);
  });

  it("still refuses when the blob declares NO content-length", async () => {
    // The case the header check could never cover. A chunked response has no
    // `content-length`, and `Number(null)` is 0 — which passes any `> MAX`
    // test and hands an unbounded body straight to the parser. Storage that
    // streams is the normal case, not an exotic one.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/chunked",
      },
    });
    fetchMock.mockResolvedValue(
      new Response(oversizedTranscriptStream(), { status: 200 })
    );
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    const body = (await res.json()) as {
      transcriptUnavailable?: boolean;
      messageCount: number | null;
    };
    expect(body.transcriptUnavailable).toBe(true);
    expect(body.messageCount).toBeNull();
  });

  it("does not refuse a large-but-allowed transcript", async () => {
    // The other half of the ceiling: a cap that also rejected ordinary
    // conversations would report `transcriptUnavailable` for sessions that are
    // perfectly readable, and every one of them would look like a storage
    // fault to whoever was reading the results.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/big",
      },
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          Array.from({ length: 200 }, (_, index) => ({
            role: "user",
            content: "x".repeat(1024) + index,
          }))
        ),
        { status: 200 }
      )
    );
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    const body = (await res.json()) as {
      transcriptUnavailable?: boolean;
      messageCount: number | null;
    };
    expect(body.transcriptUnavailable).toBeUndefined();
    expect(body.messageCount).toBe(200);
  });

  it("reports an unreadable blob rather than an empty conversation", async () => {
    // "They said nothing" and "we could not fetch it" lead to opposite
    // conclusions about a user test.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: {
        chatboxId: SCENARIO,
        chatSessionId: "cs_1",
        messagesBlobUrl: "https://storage.test/blob",
      },
    });
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    const body = (await res.json()) as {
      transcriptUnavailable?: boolean;
      messages: unknown[];
    };
    expect(body.transcriptUnavailable).toBe(true);
    expect(body.messages).toEqual([]);
  });
});

describe("exposure controls", () => {
  it("sends the full guest-execution set, never a partial patch", async () => {
    mutationMock.mockResolvedValue(null);
    const caps = {
      enabled: true,
      computerEnabled: false,
      sharedSkillsEnabled: false,
      dailyCreditCap: 100,
      dailyComputerStartCap: 0,
      maxConcurrentComputers: 0,
      // The harness half of the set. Optional upstream, so it is the half most
      // likely to be dropped in transit without anyone noticing — and a
      // spend cap that silently fails to arrive is the one worth pinning.
      harnessEnabled: true,
      dailyHarnessSpendCapMicros: 5_000_000,
      dailyHarnessCallCap: 250,
      maxConcurrentHarnessRuns: 2,
    };
    const res = await call(userTesting, "PUT", `${BASE}/guest-execution`, caps);
    expect(res.status).toBe(200);
    // Asserted BEFORE the destructure: a rejected body would otherwise fail
    // with "undefined is not iterable" instead of naming the real problem.
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const [, args] = mutationMock.mock.calls[0] as [
      string,
      { guestExecution: Record<string, unknown> }
    ];
    expect(args.guestExecution).toEqual(caps);
  });

  it("rejects a partial guest-execution body", async () => {
    // These caps only mean something as a set; raising one while leaving a
    // stale sibling produces a combination nobody chose.
    const res = await call(userTesting, "PUT", `${BASE}/guest-execution`, {
      enabled: true,
    });
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("checks the target environment is in THIS project before rebinding", async () => {
    // The Convex mutation resolves the environment itself, so without the
    // preflight a member of two projects could rebind onto the other's
    // environment and expose it under this project's link.
    // Keyed rather than ordered: the default `beforeEach` already answers
    // `getChatbox`, and `null` for the environment read is what makes this a
    // cross-project miss.
    answerQueries({ getChatbox: scenarioRow(), getEnvironment: null });
    const res = await call(userTesting, "POST", `${BASE}/rebind`, {
      environmentId: "env_in_b",
    });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("rotates the link without minting an accessVersion it never had", async () => {
    // The mutation returns the settings envelope: a `link` object and NO
    // `accessVersion` (only publish/rebind return one). The old response
    // reported `accessVersion: null` forever while documenting it as the
    // revocation signal.
    mutationMock.mockResolvedValue({
      link: { token: "tok", path: "/s/tok", url: "https://app.test/s/tok" },
      members: [],
    });
    const res = await call(userTesting, "POST", `${BASE}/rotate-link`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rotated).toBe(true);
    expect(body).not.toHaveProperty("accessVersion");
  });

  it("404s rotate's REAL insufficient-role refusal — it is not an admin gate", async () => {
    // `rotateChatboxLink` gates at `requireWorkspaceRole(..., 'guest')` and
    // throws PLAIN errors ("Not a member of this workspace"), never a
    // ConvexError with a FORBIDDEN code — a previous version of this test
    // mocked that fictional shape and asserted a 403 the mutation can never
    // produce. The real refusal means the caller cannot see the workspace at
    // all, so the translator's prose fallback collapses it to the same
    // neutral 404 as a missing scenario. (In production Convex redacts the
    // plain error to "Server Error" before it reaches us; the preflight
    // normally answers first with its own 404 either way.)
    mutationMock.mockRejectedValue(new Error("Not a member of this workspace"));
    const res = await call(userTesting, "POST", `${BASE}/rotate-link`);
    expect(res.status).toBe(404);
  });

  it("surfaces guest-execution's REAL admin refusal as 403, not a 404", async () => {
    // `setChatboxGuestExecution` is the exposure control that genuinely
    // requires project admin, and its refusal is a plain error naming the
    // requirement. The caller is already a workspace member (Convex confirmed
    // it to serve the preflight), so "only project admins" is actionable and
    // reveals nothing new.
    mutationMock.mockRejectedValue(
      new Error("Only project admins can configure guest execution")
    );
    const res = await call(userTesting, "PUT", `${BASE}/guest-execution`, {
      enabled: true,
      computerEnabled: false,
      sharedSkillsEnabled: false,
      dailyCreditCap: 100,
      dailyComputerStartCap: 0,
      maxConcurrentComputers: 0,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/project admins/i);
  });
});

describe("findings", () => {
  it("matches a chatbox finding on `_id`, the column it actually has", async () => {
    // The swarm findings DTO names this column `findingId` and this one does
    // not. Matching on the swarm spelling made the scope check impossible to
    // pass, so every chatbox dismissal answered 404.
    answerQueries({
      getChatbox: scenarioRow(),
      listChatboxFindings: [{ _id: "finding_1" }],
    });
    mutationMock.mockResolvedValue(null);
    const res = await call(
      userTesting,
      "POST",
      `${BASE}/findings/finding_1/dismiss`
    );
    expect(res.status).toBe(200);
    expect(mutationMock).toHaveBeenCalledTimes(1);
  });

  it("404s a finding belonging to a different scenario", async () => {
    answerQueries({
      getChatbox: scenarioRow(),
      listChatboxFindings: [{ _id: "finding_elsewhere" }],
    });
    const res = await call(
      userTesting,
      "POST",
      `${BASE}/findings/finding_1/dismiss`
    );
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("insight lifecycle", () => {
  it("answers 202 with the window the request applies to", async () => {
    mutationMock.mockResolvedValue({ windowGroupId: "win_1" });
    const res = await call(userTesting, "POST", `${BASE}/insights`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      windowId: "win_1",
      status: "pending",
    });
  });

  it("turns window_not_analyzed into a 409 with real copy", async () => {
    // Well-formed request, wrong moment. A 400 would tell the caller to fix
    // input that was fine, and a retry loop would never converge.
    mutationMock.mockRejectedValue(new Error("window_not_analyzed"));
    const res = await call(userTesting, "POST", `${BASE}/insights`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/not been analyzed/i);
  });
});

describe("probe answers (the preflight is not an oracle)", () => {
  /** Every query rejects with `error`; used to fail the preflight itself. */
  function failAllQueries(error: Error) {
    queryMock.mockImplementation(() => Promise.reject(error));
  }

  it("404s a malformed scenario id instead of paging as a 502", async () => {
    // `v.id('chatboxes')` rejects before the handler runs. That is a caller
    // problem, not an incident — and 502-vs-404 must not distinguish
    // "malformed" from "missing".
    failAllQueries(
      new Error("ArgumentValidationError: Value does not match validator")
    );
    const res = await call(userTesting, "GET", `${BASE}/usage`);
    expect(res.status).toBe(404);
  });

  it("404s a cross-WORKSPACE refusal exactly like a missing scenario", async () => {
    // `getChatbox` authorizes at workspace scope, so its refusal wording
    // differs from the project one — before the classifier knew it, this
    // answered 502 and told the prober the id exists somewhere.
    failAllQueries(new Error("Not a member of this workspace"));
    const res = await call(userTesting, "GET", `${BASE}/usage`);
    expect(res.status).toBe(404);
  });

  it("404s production's redacted refusal at the preflight", async () => {
    // In production a plain-error refusal arrives as "Server Error". At the
    // preflight, refusal and absence must be indistinguishable.
    failAllQueries(new Error("[Request ID: abc] Server Error"));
    const res = await call(userTesting, "GET", `${BASE}/usage`);
    expect(res.status).toBe(404);
  });

  it("keeps 502 for a redacted error AFTER the preflight passed", async () => {
    // Same string, different meaning: once the scenario resolved, a redacted
    // error is a genuine upstream incident and must surface as one.
    queryMock.mockImplementation((name: string) => {
      const fn = String(name).split(":").pop() ?? "";
      if (fn === "getChatbox") return Promise.resolve(scenarioRow());
      return Promise.reject(new Error("[Request ID: abc] Server Error"));
    });
    const res = await call(userTesting, "GET", `${BASE}/usage`);
    expect(res.status).toBe(502);
  });

  it("400s an unknown population value instead of 404ing it", async () => {
    // The bad value is the caller's query parameter — they need the accepted
    // values, not a claim the scenario is gone.
    const res = await call(
      userTesting,
      "GET",
      `${BASE}/metrics?population=fake`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/real.*synthetic/i);
  });
});

describe("member invite default", () => {
  it("forwards an explicit sendInviteEmail: false when the caller omits it", async () => {
    // The backend defaults an ABSENT flag to true and emails the person a
    // working share link. This route documents quiet-add as its default, so
    // absence must reach Convex as an explicit false.
    mutationMock.mockResolvedValue({ memberId: "m_1" });
    await call(userTesting, "PUT", `${BASE}/members`, {
      email: "tester@example.com",
    });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const [fn, args] = mutationMock.mock.calls[0]!;
    expect(fn).toBe("chatboxes:upsertChatboxMember");
    expect((args as { sendInviteEmail?: boolean }).sendInviteEmail).toBe(false);
  });

  it("still honors an explicit sendInviteEmail: true", async () => {
    mutationMock.mockResolvedValue({ memberId: "m_1", invited: true });
    await call(userTesting, "PUT", `${BASE}/members`, {
      email: "tester@example.com",
      sendInviteEmail: true,
    });
    const [, args] = mutationMock.mock.calls[0]!;
    expect((args as { sendInviteEmail?: boolean }).sendInviteEmail).toBe(true);
  });
});

describe("deleted transcript blob", () => {
  it("reports transcriptUnavailable, not an empty conversation", async () => {
    // `messagesBlobId` is required, so a session always HAS a blob — a null
    // URL means `storage.getUrl` found the file deleted. "We cannot read it"
    // and "the visitor said nothing" lead to opposite conclusions.
    answerQueries({
      getChatbox: scenarioRow(),
      getSession: { chatboxId: SCENARIO, chatSessionId: "cs_1" },
    });
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messageCount: number | null;
      transcriptUnavailable?: boolean;
      messages: unknown[];
    };
    expect(body.transcriptUnavailable).toBe(true);
    expect(body.messageCount).toBeNull();
    expect(body.messages).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET scenario detail (insights envelope)", () => {
  it("returns the scenario with its envelope, members only by construction", async () => {
    const envelope = {
      schemaVersion: 1,
      scope: {
        kind: "user_testing_window",
        id: "grp_1",
        scenarioId: SCENARIO,
        windowStartAt: 1,
        windowEndAt: 2,
      },
      status: "completed",
      reasonCode: null,
      retryable: false,
      error: null,
      generatedAt: 5,
      updatedAt: 6,
      summary: "One tool keeps failing.",
      coverage: {
        unit: "sessions",
        analyzed: 3,
        total: 3,
        feedbackCount: 1,
        truncated: false,
        lowConfidence: false,
      },
      findings: [],
      truncation: {
        truncated: false,
        omittedFindings: 0,
        omittedEvidence: 0,
        contractTruncated: false,
      },
    };
    answerQueries({
      getChatbox: { ...scenarioRow(), environmentId: "env_9" },
      getScenarioInsightsEnvelope: envelope,
    });
    const res = await call(userTesting, "GET", BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: SCENARIO,
      projectId: PROJECT,
      name: "Checkout",
      environmentId: "env_9",
    });
    expect(body.insights).toEqual(envelope);
  });

  it("404s when the envelope query refuses (non-member) or finds nothing", async () => {
    answerQueries({
      getChatbox: scenarioRow(),
      getScenarioInsightsEnvelope: null,
    });
    const res = await call(userTesting, "GET", BASE);
    expect(res.status).toBe(404);
  });

  it("404s across projects before any insight read", async () => {
    answerQueries({ getChatbox: scenarioRow(OTHER_PROJECT) });
    const res = await call(userTesting, "GET", BASE);
    expect(res.status).toBe(404);
  });
});
