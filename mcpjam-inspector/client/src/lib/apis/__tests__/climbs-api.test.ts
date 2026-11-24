import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

import {
  ClimbsApiError,
  confirmClimb,
  continueClimb,
  decideRound,
  draftChange,
  forgetMockChanges,
  getClimb,
  getClimbRound,
  isClimbsApiError,
  listClimbs,
  mockChangesBetween,
  readMockDefinition,
  saveMockDefinition,
  submitRound,
  updateClimbMeasure,
  verifyClimb,
  startClimb,
  stopClimb,
} from "../climbs-api";

const params = {
  projectId: "p 1",
  suiteId: "s",
  serverId: "srv",
  roundLimit: 3,
  creditLimit: 500,
};

function respond(body: unknown, status = 200) {
  authFetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function lastCall() {
  const [input, init] = authFetch.mock.calls.at(-1) as [RequestInfo | URL, RequestInit];
  const url = new URL(String(input), "http://localhost");
  return { url, init, headers: new Headers(init.headers) };
}

const failure = (run: Promise<unknown>) => run.catch((error) => error) as Promise<ClimbsApiError>;

beforeEach(() => {
  authFetch.mockReset();
  forgetMockChanges();
});
afterEach(() => vi.clearAllMocks());

describe("climbs api: start", () => {
  it("starts a climb with MCPJam as the picker and its model", async () => {
    respond({ climbId: "c2" }, 201);
    await startClimb({ ...params, picker: "mcpjam", pickerModel: "anthropic/sonnet" });
    const { url, init, headers } = lastCall();
    expect(init.method).toBe("POST");
    expect(url.pathname).toBe("/api/v1/projects/p%201/climbs");
    // authFetch owns the bearer.
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      suiteId: "s",
      serverId: "srv",
      roundLimit: 3,
      creditLimit: 500,
      picker: "mcpjam",
      pickerModel: "anthropic/sonnet",
    });
  });

  it("says the feature is off, apart from a permission refusal", async () => {
    respond(
      { code: "FORBIDDEN", message: "off", details: { code: "FEATURE_UNAVAILABLE", feature: "climbs" } },
      403,
    );
    const error = await failure(startClimb(params));
    expect(isClimbsApiError(error)).toBe(true);
    expect(error.kind).toBe("unavailable");
    expect(error.message).toMatch(/not turned on/);
  });

  it("keeps a missing resource apart from a failed request", async () => {
    respond({ code: "NOT_FOUND", message: "Server not found" }, 404);
    expect((await failure(startClimb(params))).kind).toBe("notFound");
  });

  it("passes the backend's refusal through, with its code", async () => {
    respond(
      {
        code: "VALIDATION_ERROR",
        message: "This suite has no cases that can steer. Add cases, then start again.",
        details: { code: "CLIMB_NO_STEERING_CASES" },
      },
      400,
    );
    const error = await failure(startClimb(params));
    expect(error.kind).toBe("refused");
    expect(error.code).toBe("CLIMB_NO_STEERING_CASES");
    expect(error.message).toMatch(/Add cases/);
  });

  it("reports a request that did not complete", async () => {
    // A gateway answer with no body: the request failed, and the climb is not at fault.
    authFetch.mockResolvedValue(new Response("", { status: 502 }));
    const error = await failure(startClimb(params));
    expect(error.kind).toBe("requestFailed");
    expect(error.status).toBe(502);
  });
});

describe("climbs api: reads and the rest", () => {
  it("lists a suite's climbs", async () => {
    respond({ items: [{ climbId: "c1", suiteId: "s1", state: "ready" }] });
    expect(await listClimbs({ projectId: "p", suiteId: "s1" })).toEqual([
      { climbId: "c1", suiteId: "s1", state: "ready" },
    ]);
    const { url } = lastCall();
    expect(url.pathname).toBe("/api/v1/projects/p/climbs");
    expect(url.searchParams.get("suiteId")).toBe("s1");
  });

  it("reads one climb", async () => {
    respond({ climbId: "c1", state: "running", rounds: [] });
    expect((await getClimb({ projectId: "p", climbId: "c1" })).state).toBe("running");
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1");
  });

  it("resumes a paused climb", async () => {
    respond({ resumed: true, stepDue: true });
    await expect(continueClimb({ projectId: "p", climbId: "c1" })).resolves.toEqual({
      resumed: true,
      stepDue: true,
    });
    const { url, init } = lastCall();
    expect(init.method).toBe("POST");
    expect(url.pathname).toBe("/api/v1/projects/p/climbs/c1/continue");
  });

  it("stops a climb", async () => {
    respond({ climbId: "c1", state: "stopped", prompt: "p", kept: [] });
    expect((await stopClimb({ projectId: "p", climbId: "c1" })).state).toBe("stopped");
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/stop");
  });

  it("reads what one mock version changed, once", async () => {
    authFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ id: "m", changes: [{ summary: "Hid the tool" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const params = { projectId: "p", mockId: "m 1", version: 3, sinceVersion: 2 };
    const [first, second] = await Promise.all([mockChangesBetween(params), mockChangesBetween(params)]);
    expect(first).toEqual([{ summary: "Hid the tool" }]);
    expect(second).toBe(first);
    expect(authFetch).toHaveBeenCalledTimes(1);
    const { url } = lastCall();
    expect(url.pathname).toBe("/api/v1/projects/p/mock-servers/m%201");
    expect(url.searchParams.get("version")).toBe("3");
    expect(url.searchParams.get("since")).toBe("2");
  });

  it("does not keep a failed read of a mock's changes", async () => {
    respond({ code: "NOT_FOUND", message: "Mock not found" }, 404);
    await expect(
      mockChangesBetween({ projectId: "p", mockId: "m", version: 3, sinceVersion: 2 }),
    ).rejects.toMatchObject({ kind: "notFound" });
    respond({ id: "m", changes: [] });
    await expect(
      mockChangesBetween({ projectId: "p", mockId: "m", version: 3, sinceVersion: 2 }),
    ).resolves.toEqual([]);
  });
});

describe("climbs api: rounds, mocks, the end", () => {
  const body = () => JSON.parse(String(lastCall().init.body));

  it("reads one round and overrules it with a reason", async () => {
    respond({ number: 2, status: "settled" });
    await getClimbRound({ projectId: "p", climbId: "c1", roundNumber: 2 });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/rounds/2");
    respond({ climbId: "c1" });
    await decideRound({ projectId: "p", climbId: "c1", roundNumber: 2, decision: "kept", reason: "It reads better." });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/rounds/2/decision");
    expect(body()).toEqual({ decision: "kept", reason: "It reads better." });
  });

  it("sets what the climb is for", async () => {
    respond({ climbId: "c1", measure: "tokens" });
    await updateClimbMeasure({ projectId: "p", climbId: "c1", measure: "tokens" });
    expect(lastCall().init.method).toBe("PATCH");
    expect(body()).toEqual({ measure: "tokens" });
  });

  it("reads a mock's definition and head version, saves a whole definition, and submits the saved version", async () => {
    respond({ id: "m", definition: { tools: {} }, headVersion: 3 });
    expect(await readMockDefinition({ projectId: "p", mockId: "m", version: 2 })).toEqual({ definition: { tools: {} }, headVersion: 3 });
    expect(lastCall().url.searchParams.get("version")).toBe("2");
    respond({ version: 4, created: true }, 201);
    await saveMockDefinition({ projectId: "p", mockId: "m", definition: { tools: { a: {} } }, expectedVersion: 3 });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/mock-servers/m/versions");
    expect(body()).toEqual({ definition: { tools: { a: {} } }, expectedVersion: 3 });
    respond({ roundNumber: 2 }, 202);
    await submitRound({ projectId: "p", climbId: "c1", serverId: "m", serverVersion: "4", idempotencyKey: "k" });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/rounds");
    expect(body()).toEqual({ serverId: "m", serverVersion: "4", idempotencyKey: "k" });
  });

  it("asks for a draft of one tool", async () => {
    respond({ description: "Lists them.", patchJson: "{}" });
    await draftChange({ projectId: "p", climbId: "c1", toolName: "list_projects", includeTitle: false });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/draft");
    expect(body()).toEqual({ toolName: "list_projects", includeTitle: false });
  });

  it("quotes the confirmation with a dry run, and verifies with a commit and runAnyway", async () => {
    respond({ dryRun: true });
    await confirmClimb({ projectId: "p", climbId: "c1", dryRun: true });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/confirmation");
    expect(body()).toEqual({ dryRun: true });
    respond({ ran: true });
    await verifyClimb({ projectId: "p", climbId: "c1", commit: { sha: "4f2c9ab" }, runAnyway: true });
    expect(lastCall().url.pathname).toBe("/api/v1/projects/p/climbs/c1/verifications");
    expect(body()).toEqual({ commit: { sha: "4f2c9ab" }, runAnyway: true });
  });
});
