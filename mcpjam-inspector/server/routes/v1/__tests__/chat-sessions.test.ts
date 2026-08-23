import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The chat-session DETAIL surface (`chat-sessions.ts`).
 *
 * These pin the things that would fail quietly and expose something:
 *
 *   1. NO BLOB URL EVER. `getSession` / `getSessionTurnTraces` return
 *      direct handles on stored blobs with no further authorization.
 *      Returning one would turn one authorized read into an unbounded,
 *      shareable one.
 *   2. OPAQUE 404. Unauthorized, missing, and cross-project all read as
 *      the same 404. Never 403 — that confirms the id exists.
 *   3. GUEST DENY. The allowlist stays the exact match `/chat-sessions`.
 *      Detail and trace must not inherit it.
 *   4. BOUNDED READ. A chunked oversized blob reports unavailability
 *      rather than landing in memory.
 */

const { queryMock, fetchMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import chatSessions from "../chat-sessions.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const SESSION = "sess_1";
const PROJECT = "proj_a";
const OTHER_PROJECT = "proj_b";
const BASE = `/api/v1/chat-sessions/${SESSION}`;

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", chatSessions);
  return app;
}

function call(method: string, path: string) {
  return makeApp().request(path, { method });
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: SESSION,
    chatSessionId: "cs_1",
    projectId: PROJECT,
    customTitle: "Refunds",
    status: "active",
    origin: "playground",
    sourceType: "direct",
    version: 3,
    modelId: "openai/gpt-4.1",
    startedAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_100_000,
    messagesBlobUrl: "https://storage.test/secret-messages",
    resumeConfig: {
      modelId: "openai/gpt-4.1",
      toolMode: "read_only",
      environmentId: "env_1",
      serverIds: ["srv_1"],
      systemPrompt: "you are a secret",
    },
    ...overrides,
  };
}

function answerQueries(answers: Record<string, unknown>) {
  queryMock.mockImplementation((name: string) => {
    const fn = String(name).split(":").pop() ?? "";
    if (Object.prototype.hasOwnProperty.call(answers, fn)) {
      return Promise.resolve(answers[fn]);
    }
    return Promise.resolve(null);
  });
}

const OVERSIZED_MESSAGE_COUNT = 16;

function oversizedTranscriptStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
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
  answerQueries({ getSession: sessionRow() });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("guest allowlist", () => {
  it("keeps the list open and the detail + trace closed", () => {
    expect(isGuestAllowedV1Request("GET", "/api/v1/chat-sessions")).toBe(true);
    expect(
      isGuestAllowedV1Request("GET", `/api/v1/chat-sessions/${SESSION}`)
    ).toBe(false);
    expect(
      isGuestAllowedV1Request("GET", `/api/v1/chat-sessions/${SESSION}/trace`)
    ).toBe(false);
  });
});

describe("session detail", () => {
  it("NEVER returns the stored blob URL or first-turn secrets", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ role: "user", content: "hello" }]), {
        status: 200,
      })
    );
    const res = await call("GET", BASE);
    const raw = await res.text();
    expect(raw).not.toContain("secret-messages");
    expect(raw).not.toContain("messagesBlobUrl");
    expect(raw).not.toContain("you are a secret");
    expect(JSON.parse(raw)).toMatchObject({
      id: SESSION,
      chatSessionId: "cs_1",
      projectId: PROJECT,
      title: "Refunds",
      origin: "playground",
      sourceType: "direct",
      version: 3,
      resumeConfig: {
        modelId: "openai/gpt-4.1",
        toolMode: "read_only",
        environmentId: "env_1",
        serverIds: ["srv_1"],
      },
      messages: [{ role: "user", text: "hello" }],
    });
  });

  it("404s a session that belongs to a DIFFERENT project", async () => {
    answerQueries({
      getSession: sessionRow({ projectId: OTHER_PROJECT }),
    });
    const res = await call("GET", `${BASE}?projectId=${PROJECT}`);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s a missing session the same way as an unauthorized one", async () => {
    answerQueries({});
    const missing = await call("GET", BASE);
    expect(missing.status).toBe(404);

    queryMock.mockRejectedValue(
      new Error("ChatSession not found or unauthorized")
    );
    const unauthorized = await call("GET", BASE);
    expect(unauthorized.status).toBe(404);
    expect(unauthorized.status).not.toBe(403);
  });

  it("pages long transcripts instead of returning the whole thing", async () => {
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
    const res = await call("GET", `${BASE}?limit=50`);
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
    const res = await call("GET", `${BASE}?cursor=oops`);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s a zero, fractional, or unparseable limit", async () => {
    for (const limit of ["0", "1.5", "oops"]) {
      const res = await call("GET", `${BASE}?limit=${limit}`);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps an oversized limit to the documented ceiling", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          Array.from({ length: 250 }, (_, index) => ({
            role: "user",
            content: `m${index}`,
          }))
        ),
        { status: 200 }
      )
    );
    const res = await call("GET", `${BASE}?limit=999`);
    const body = (await res.json()) as {
      messages: unknown[];
      nextCursor?: string;
    };
    expect(body.messages).toHaveLength(200);
    expect(body.nextCursor).toBe("200");
  });

  it("does not follow redirects and treats them as unreadable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    const res = await call("GET", BASE);
    const body = (await res.json()) as { transcriptUnavailable?: boolean };
    expect(body.transcriptUnavailable).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("reports a null messageCount when the transcript is unreadable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await call("GET", BASE);
    const body = (await res.json()) as {
      messageCount: number | null;
      transcriptUnavailable?: boolean;
      messages: unknown[];
    };
    expect(body.messageCount).toBeNull();
    expect(body.transcriptUnavailable).toBe(true);
    expect(body.messages).toEqual([]);
  });

  it("still refuses when the blob declares NO content-length", async () => {
    fetchMock.mockResolvedValue(
      new Response(oversizedTranscriptStream(), { status: 200 })
    );
    const res = await call("GET", BASE);
    const body = (await res.json()) as {
      transcriptUnavailable?: boolean;
      messageCount: number | null;
    };
    expect(body.transcriptUnavailable).toBe(true);
    expect(body.messageCount).toBeNull();
  });
});

describe("incremental trace", () => {
  function turn(
    promptIndex: number,
    url = `https://storage.test/spans-${promptIndex}`
  ) {
    return {
      turnId: `turn_${promptIndex}`,
      promptIndex,
      startedAt: 1_000 + promptIndex,
      endedAt: 2_000 + promptIndex,
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4 },
      spanCount: 1,
      modelId: "openai/gpt-4.1",
      spansBlobUrl: url,
    };
  }

  it("NEVER returns a spansBlobUrl and inlines the fetched spans", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: [turn(0, "https://storage.test/secret-spans")],
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ name: "llm", durationMs: 12 }]), {
        status: 200,
      })
    );
    const res = await call("GET", `${BASE}/trace`);
    const raw = await res.text();
    expect(raw).not.toContain("secret-spans");
    expect(raw).not.toContain("spansBlobUrl");
    expect(JSON.parse(raw)).toMatchObject({
      id: SESSION,
      turnCount: 1,
      turns: [
        {
          turnId: "turn_0",
          promptIndex: 0,
          spans: [{ name: "llm", durationMs: 12 }],
        },
      ],
    });
  });

  it("pages from afterPromptIndex so a poller does not re-download", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: [turn(0), turn(1), turn(2)],
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    const res = await call("GET", `${BASE}/trace?afterPromptIndex=0&limit=1`);
    const body = (await res.json()) as {
      turns: Array<{ promptIndex: number }>;
      turnCount: number;
      nextCursor?: string;
    };
    expect(body.turns.map((row) => row.promptIndex)).toEqual([1]);
    expect(body.turnCount).toBe(2);
    expect(body.nextCursor).toBe("1");
  });

  it("lets cursor win over a stale afterPromptIndex", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: [turn(0), turn(1), turn(2)],
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    const res = await call("GET", `${BASE}/trace?afterPromptIndex=0&cursor=1`);
    const body = (await res.json()) as {
      turns: Array<{ promptIndex: number }>;
    };
    expect(body.turns.map((row) => row.promptIndex)).toEqual([2]);
  });

  it("404s a cross-project probe the same as a missing session", async () => {
    answerQueries({
      getSession: sessionRow({ projectId: OTHER_PROJECT }),
    });
    const res = await call("GET", `${BASE}/trace?projectId=${PROJECT}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("marks spansUnavailable when the blob cannot be read", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: [turn(0)],
    });
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await call("GET", `${BASE}/trace`);
    const body = (await res.json()) as {
      turns: Array<{ spansUnavailable?: boolean; spans: unknown[] }>;
    };
    expect(body.turns[0]?.spansUnavailable).toBe(true);
    expect(body.turns[0]?.spans).toEqual([]);
  });

  it("400s a zero, fractional, or unparseable trace limit", async () => {
    for (const limit of ["0", "1.5", "oops"]) {
      const res = await call("GET", `${BASE}/trace?limit=${limit}`);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps an oversized trace limit to the documented ceiling", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: Array.from({ length: 60 }, (_, index) =>
        turn(index)
      ),
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    const res = await call("GET", `${BASE}/trace?limit=999`);
    const body = (await res.json()) as {
      turns: unknown[];
      turnCount: number;
      nextCursor?: string;
    };
    expect(body.turns).toHaveLength(50);
    expect(body.turnCount).toBe(60);
    expect(body.nextCursor).toBe("49");
  });

  it("treats a missing or non-array trace list as empty", async () => {
    for (const traces of [[], { nope: true }, null]) {
      answerQueries({
        getSession: sessionRow(),
        getSessionTurnTraces: traces,
      });
      const res = await call("GET", `${BASE}/trace`);
      const body = (await res.json()) as {
        turns: unknown[];
        turnCount: number;
      };
      expect(body.turns).toEqual([]);
      expect(body.turnCount).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks spansUnavailable when the blob is not a JSON array", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: [turn(0)],
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ spans: [] }), { status: 200 })
    );
    const res = await call("GET", `${BASE}/trace`);
    const body = (await res.json()) as {
      turns: Array<{ spansUnavailable?: boolean; spans: unknown[] }>;
    };
    expect(body.turns[0]?.spansUnavailable).toBe(true);
    expect(body.turns[0]?.spans).toEqual([]);
  });

  it("fetches at most four span blobs at once", async () => {
    answerQueries({
      getSession: sessionRow(),
      getSessionTurnTraces: Array.from({ length: 8 }, (_, index) =>
        turn(index)
      ),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(new Response(JSON.stringify([]), { status: 200 }));
          }, 20);
        })
    );
    const res = await call("GET", `${BASE}/trace?limit=8`);
    expect(res.status).toBe(200);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});
