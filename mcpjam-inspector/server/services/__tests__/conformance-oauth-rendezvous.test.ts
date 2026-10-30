import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ConformanceResult } from "@mcpjam/sdk";
import type { OAuthConformanceSession } from "../conformance-oauth-sessions.js";

// The replica running a hosted OAuth conformance run waits for the code in
// Convex and publishes the result there; any replica reads it back. These pin
// the delivery order (poll → deliver → ack), when the wait gives up, what the
// published result may contain, and how `/oauth/complete` reads it.

const mutation = vi.fn();
const query = vi.fn();
const setAuth = vi.fn();
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = (token: string) => setAuth(token);
    mutation = (...args: unknown[]) => mutation(...args);
    query = (...args: unknown[]) => query(...args);
  },
}));

const touchSession = vi.fn();
vi.mock("../conformance-oauth-sessions.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../conformance-oauth-sessions.js")
  >()),
  touchSession: (id: string) => touchSession(id),
}));

import {
  OAUTH_RUN_STOPPED_MESSAGE,
  awaitRendezvousResult,
  liveConformanceOAuthRunCount,
  runRendezvousOnThisReplica,
  stopLiveConformanceOAuthRuns,
  submitRendezvousCode,
} from "../conformance-oauth-rendezvous.js";

const SECRET = "client-secret-value";
const ACCESS_TOKEN = "access-token-value";

/** Route responses keyed by path, consumed in order (the last one repeats). */
function stubFetch(routes: Record<string, unknown[]>) {
  const calls: Array<{ path: string; body: any; headers: any }> = [];
  const cursor: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(init.body), headers: init.headers });
      const queue = routes[path] ?? [{ ok: true }];
      const index = Math.min(cursor[path] ?? 0, queue.length - 1);
      cursor[path] = (cursor[path] ?? 0) + 1;
      const next = queue[index];
      if (next instanceof Error) throw next;
      return { ok: true, json: async () => next } as any;
    }),
  );
  return {
    calls,
    paths: () => calls.map((call) => call.path),
  };
}

function controllableRun() {
  let resolve!: (result: ConformanceResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ConformanceResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSession(runnerPromise: Promise<ConformanceResult>) {
  return {
    id: "oauth-conf-1",
    controller: { deliverCode: vi.fn(), fail: vi.fn() },
    runnerPromise,
    completedSteps: [],
    createdAt: 0,
    lastActivityAt: 0,
  } as unknown as OAuthConformanceSession & {
    controller: {
      deliverCode: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
    };
  };
}

function rawResult(): ConformanceResult {
  const attempt = {
    step: "token_request",
    timestamp: 1,
    request: {
      method: "POST",
      url: "https://auth.example/token",
      headers: { Authorization: `Basic ${btoa(`client:${SECRET}`)}` },
      body: { client_secret: SECRET },
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      body: { access_token: ACCESS_TOKEN },
    },
  };
  return {
    passed: true,
    outcome: "passed",
    protocolVersion: "2025-11-25",
    registrationStrategy: "preregistered",
    serverUrl: "https://mcp.example/mcp",
    summary: "OAuth conformance passed",
    durationMs: 20,
    credentials: {
      clientId: "client",
      clientSecret: SECRET,
      accessToken: ACCESS_TOKEN,
    },
    steps: [
      {
        step: "token_request",
        title: "Request Tokens with Authorization Code",
        summary: "Exchange the code for a token.",
        status: "passed",
        durationMs: 12,
        logs: [],
        http: attempt,
        httpAttempts: [attempt],
      },
    ],
  } as unknown as ConformanceResult;
}

const awaiting = { ok: true, rendezvous: { status: "awaiting_code" } };
const submitted = {
  ok: true,
  rendezvous: { status: "code_submitted", code: "auth-code", state: "st-1" },
};

let randomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  // No jitter: one poll per second exactly.
  randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  mutation.mockReset();
  query.mockReset();
  setAuth.mockReset();
  touchSession.mockReset();
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex-http.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-token-0123456789";
});

afterEach(async () => {
  await stopLiveConformanceOAuthRuns();
  randomSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("running replica: waiting for the code", () => {
  it("polls with the service token, delivers the code, then acks", async () => {
    const http = stubFetch({
      "/conformance-oauth/poll": [awaiting, submitted],
    });
    const run = controllableRun();
    const session = fakeSession(run.promise);

    runRendezvousOnThisReplica(session);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(session.controller.deliverCode).not.toHaveBeenCalled();
    expect(touchSession).toHaveBeenCalledWith("oauth-conf-1");

    await vi.advanceTimersByTimeAsync(1_300);
    expect(session.controller.deliverCode).toHaveBeenCalledWith({
      code: "auth-code",
      state: "st-1",
    });
    expect(http.paths()).toEqual([
      "/conformance-oauth/poll",
      "/conformance-oauth/poll",
      "/conformance-oauth/ack",
    ]);
    expect(http.calls[0].headers["x-inspector-service-token"]).toBe(
      "svc-token-0123456789",
    );

    // The code is in: no more polling.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.paths().filter((p) => p.endsWith("/poll"))).toHaveLength(2);
  });

  it("fails the wait when the row is gone", async () => {
    stubFetch({ "/conformance-oauth/poll": [{ ok: true, rendezvous: null }] });
    const session = fakeSession(controllableRun().promise);

    runRendezvousOnThisReplica(session);
    await vi.advanceTimersByTimeAsync(1_300);

    expect(session.controller.fail).toHaveBeenCalledWith(
      new Error("Authorization took too long. Run the checks again."),
    );
    expect(session.controller.deliverCode).not.toHaveBeenCalled();
  });

  it("gives up after 30 failed polls in a row", async () => {
    stubFetch({ "/conformance-oauth/poll": [new Error("network down")] });
    const session = fakeSession(controllableRun().promise);

    runRendezvousOnThisReplica(session);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(session.controller.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.controller.fail).toHaveBeenCalledWith(
      new Error(OAUTH_RUN_STOPPED_MESSAGE),
    );
  });
});

describe("running replica: publishing the result", () => {
  it("publishes the browser-safe result only", async () => {
    const http = stubFetch({ "/conformance-oauth/poll": [awaiting] });
    const run = controllableRun();
    runRendezvousOnThisReplica(fakeSession(run.promise));

    run.resolve(rawResult());
    await vi.advanceTimersByTimeAsync(10);

    const finish = http.calls.find(
      (c) => c.path === "/conformance-oauth/finish",
    );
    expect(finish?.body.sessionId).toBe("oauth-conf-1");
    const published = finish!.body.resultJson as string;
    expect(JSON.parse(published).passed).toBe(true);
    expect(published).not.toContain(SECRET);
    expect(published).not.toContain(ACCESS_TOKEN);
    expect(published).not.toContain("credentials");
    expect(liveConformanceOAuthRunCount()).toBe(0);
  });

  it("publishes the error when the run throws, retrying a failed write", async () => {
    const http = stubFetch({
      "/conformance-oauth/poll": [awaiting],
      "/conformance-oauth/finish": [
        new Error("blip"),
        { ok: true, finished: true },
      ],
    });
    const run = controllableRun();
    runRendezvousOnThisReplica(fakeSession(run.promise));

    run.reject(new Error("discovery exploded"));
    await vi.advanceTimersByTimeAsync(600);

    const finishes = http.calls.filter(
      (c) => c.path === "/conformance-oauth/finish",
    );
    expect(finishes).toHaveLength(2);
    expect(finishes[1].body).toEqual({
      sessionId: "oauth-conf-1",
      error: "discovery exploded",
    });
  });

  it("still ends the row when the result can't be serialized", async () => {
    const http = stubFetch({ "/conformance-oauth/poll": [awaiting] });
    const run = controllableRun();
    runRendezvousOnThisReplica(fakeSession(run.promise));

    const broken = rawResult();
    Object.defineProperty(broken, "steps", {
      get() {
        throw new Error("unreadable steps");
      },
    });
    run.resolve(broken);
    await vi.advanceTimersByTimeAsync(10);

    expect(
      http.calls.find((c) => c.path === "/conformance-oauth/finish")?.body,
    ).toEqual({ sessionId: "oauth-conf-1", error: OAUTH_RUN_STOPPED_MESSAGE });
    expect(liveConformanceOAuthRunCount()).toBe(0);
  });

  it("marks live runs as stopped on shutdown", async () => {
    const http = stubFetch({ "/conformance-oauth/poll": [awaiting] });
    runRendezvousOnThisReplica(fakeSession(controllableRun().promise));
    expect(liveConformanceOAuthRunCount()).toBe(1);

    await stopLiveConformanceOAuthRuns();

    expect(liveConformanceOAuthRunCount()).toBe(0);
    expect(
      http.calls.find((c) => c.path === "/conformance-oauth/finish")?.body,
    ).toEqual({
      sessionId: "oauth-conf-1",
      error: OAUTH_RUN_STOPPED_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.paths().filter((p) => p.endsWith("/poll"))).toHaveLength(0);
  });
});

describe("any replica: the browser's calls", () => {
  it("submits the code with the user's bearer and maps a refusal to gone", async () => {
    mutation.mockResolvedValueOnce({ ok: true });
    expect(
      await submitRendezvousCode("Bearer user-jwt", {
        sessionId: "oauth-conf-1",
        code: "auth-code",
      }),
    ).toBe("accepted");
    expect(setAuth).toHaveBeenCalledWith("user-jwt");
    expect(getFunctionName(mutation.mock.calls[0][0])).toBe(
      "conformanceOAuthRendezvous:submitCode",
    );
    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "oauth-conf-1",
      code: "auth-code",
    });

    mutation.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect(
      await submitRendezvousCode("user-jwt", { sessionId: "x", code: "c" }),
    ).toBe("gone");
  });

  it("retries the code once on a transport error", async () => {
    mutation
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ ok: true });
    expect(
      await submitRendezvousCode("user-jwt", { sessionId: "s", code: "c" }),
    ).toBe("accepted");
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it("waits for the result, riding out a failed read", async () => {
    query
      .mockResolvedValueOnce({ status: "running" })
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({
        status: "complete",
        resultJson: '{"passed":true}',
      });

    const outcome = awaitRendezvousResult("user-jwt", "oauth-conf-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toEqual({
      phase: "complete",
      result: { passed: true },
    });
  });

  it("answers gone, failed and pending", async () => {
    query.mockResolvedValueOnce(null);
    expect(await awaitRendezvousResult("u", "s")).toEqual({ phase: "gone" });

    query.mockResolvedValueOnce({ status: "expired" });
    expect(await awaitRendezvousResult("u", "s")).toEqual({ phase: "gone" });

    query.mockResolvedValueOnce({
      status: "failed",
      error: OAUTH_RUN_STOPPED_MESSAGE,
    });
    expect(await awaitRendezvousResult("u", "s")).toEqual({
      phase: "failed",
      error: OAUTH_RUN_STOPPED_MESSAGE,
    });

    query.mockResolvedValue({ status: "awaiting_code" });
    const pending = awaitRendezvousResult("u", "s", { waitMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual({ phase: "pending" });
  });
});
