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

const scenarioRow = (projectId = PROJECT) => ({
  _id: SCENARIO,
  projectId,
  workspaceId: "ws_1",
  name: "Checkout",
  mode: "invited_only",
  accessVersion: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  vi.stubGlobal("fetch", fetchMock);
  queryMock.mockResolvedValue(scenarioRow());
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
    queryMock.mockResolvedValue({ environmentId: "env_1", projectId: PROJECT });
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
      { name: "Checkout", mode: "invited_only" }
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
      mode: "invited_only",
    });
  });

  it("says so when a republish DISCARDED the overrides", async () => {
    // They are create-time only upstream. Silence would let a caller who asked
    // for `invited_only` conclude the link is restricted when it is not.
    queryMock.mockResolvedValue({ environmentId: "env_1", projectId: PROJECT });
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

  it("still publishes with no body at all", async () => {
    queryMock.mockResolvedValue({ environmentId: "env_1", projectId: PROJECT });
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
    await call(userTesting, "PATCH", BASE, { mode: "invited_only" });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[0]).toBe("chatboxes:setChatboxMode");
  });

  it("routes a rename to updateChatbox and nothing else", async () => {
    mutationMock.mockResolvedValue(null);
    await call(userTesting, "PATCH", BASE, { name: "Renamed" });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[0]).toBe("chatboxes:updateChatbox");
  });

  it("404s a scenario that resolves into another project", async () => {
    queryMock.mockResolvedValue(scenarioRow(OTHER_PROJECT));
    const res = await call(userTesting, "PATCH", BASE, { name: "Renamed" });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("session transcript", () => {
  it("NEVER returns the stored blob URL", async () => {
    queryMock.mockResolvedValueOnce(scenarioRow()).mockResolvedValueOnce({
      chatboxId: SCENARIO,
      chatSessionId: "cs_1",
      messagesBlobUrl: "https://storage.test/secret-blob",
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
    queryMock
      .mockResolvedValueOnce(scenarioRow())
      .mockResolvedValueOnce({ chatboxId: "cb_other", chatSessionId: "cs_1" });
    const res = await call(userTesting, "GET", `${BASE}/sessions/sess_1`);
    expect(res.status).toBe(404);
  });

  it("pages long transcripts instead of returning the whole thing", async () => {
    queryMock.mockResolvedValueOnce(scenarioRow()).mockResolvedValueOnce({
      chatboxId: SCENARIO,
      chatSessionId: "cs_1",
      messagesBlobUrl: "https://storage.test/blob",
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

  it("reports an unreadable blob rather than an empty conversation", async () => {
    // "They said nothing" and "we could not fetch it" lead to opposite
    // conclusions about a user test.
    queryMock.mockResolvedValueOnce(scenarioRow()).mockResolvedValueOnce({
      chatboxId: SCENARIO,
      chatSessionId: "cs_1",
      messagesBlobUrl: "https://storage.test/blob",
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
    };
    await call(userTesting, "PUT", `${BASE}/guest-execution`, caps);
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
    queryMock.mockResolvedValueOnce(scenarioRow()).mockResolvedValueOnce(null);
    const res = await call(userTesting, "POST", `${BASE}/rebind`, {
      environmentId: "env_in_b",
    });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("surfaces the admin gate as 403, not a 404", async () => {
    // The caller is already a workspace member (Convex confirmed it to serve
    // the preflight), so "requires admin" is actionable and reveals nothing.
    mutationMock.mockRejectedValue(
      Object.assign(new Error("Requires admin"), {
        data: { code: "FORBIDDEN", message: "Requires admin" },
      })
    );
    const res = await call(userTesting, "POST", `${BASE}/rotate-link`);
    expect(res.status).toBe(403);
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
