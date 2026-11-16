/**
 * The worker's client for a run's call ledger and test plan: what it sends,
 * which answers mean stop, and how a ledger row becomes the SDK's record.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRunCallLedger,
  readRunTestPlan,
  recordRunCall,
  toCallRecord,
  type LedgerCallWrite,
} from "../call-ledger.js";
import { ReadinessLeaseLostError } from "../runner.js";

const LEASE = { runId: "run_1", jobId: "job_1" };

const ROW = {
  callKey: "create_project#valid",
  tool: "create_project",
  effect: "write",
  phase: "succeeded",
  inputDigest: "digest-1",
  ranBy: { kind: "direct-call" },
  endpoint: "https://connector.example.com/mcp",
  outcome: "result",
  captured: [{ fixture: "scratchProject", name: "id", value: "proj_scratch" }],
  attempts: 1,
  startedAt: 1_000,
  finishedAt: 1_200,
};

const WRITE: LedgerCallWrite = {
  callKey: "create_project#valid",
  tool: "create_project",
  effect: "write",
  phase: "started",
  inputDigest: "digest-1",
  ranBy: { kind: "direct-call" },
};

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("recordRunCall", () => {
  it("posts the lease and the call, and reads back the ledger's record", async () => {
    const fetchMock = answer({ ok: true, replayed: false, call: ROW });
    const result = await recordRunCall(LEASE, WRITE, 3);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://backend.test/internal/v1/claude-readiness/runs/calls",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-inspector-service-token")).toBe(
      "service-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({ ...LEASE, call: WRITE });
    expect(result).toEqual({
      kind: "recorded",
      call: {
        callKey: "create_project#valid",
        tool: "create_project",
        phase: "succeeded",
        inputDigest: "digest-1",
        ranBy: { kind: "direct-call" },
        endpoint: "https://connector.example.com/mcp",
        planRevision: 3,
        startedAt: 1_000,
        finishedAt: 1_200,
        outcome: "result",
        captured: { scratchProject: { id: "proj_scratch" } },
      },
    });
  });

  it("answers a refusal with the call as the ledger holds it", async () => {
    answer(
      {
        ok: false,
        error: "call_in_doubt",
        message: "Mark it ambiguous instead of sending it again.",
        call: {
          ...ROW,
          phase: "started",
          outcome: undefined,
          captured: undefined,
        },
      },
      409,
    );
    const result = await recordRunCall(LEASE, WRITE);
    expect(result).toMatchObject({
      kind: "refused",
      error: "call_in_doubt",
      call: { callKey: "create_project#valid", phase: "started" },
    });
  });

  it.each([
    [409, { ok: false, error: "lease_lost" }],
    [404, { ok: false, error: "not_found" }],
  ])("stops on a %s %j: the lease is gone", async (status, body) => {
    answer(body, status);
    await expect(recordRunCall(LEASE, WRITE)).rejects.toBeInstanceOf(
      ReadinessLeaseLostError,
    );
  });

  it.each([
    ["a 500", () => answer({ ok: false }, 500)],
    [
      "a route the backend does not have",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response("No matching routes found", { status: 404 }),
          ),
        ),
    ],
    [
      "a transport failure",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Promise.reject(new Error("ECONNRESET"))),
        ),
    ],
  ])("throws, without stopping the run, on %s", async (_label, arrange) => {
    arrange();
    const error = await recordRunCall(LEASE, WRITE).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ReadinessLeaseLostError);
  });
});

describe("readRunCallLedger", () => {
  it("reads the run's plan revision and its calls, by lease", async () => {
    const fetchMock = answer({ ok: true, testPlanRevision: 3, calls: [ROW] });
    const ledger = await readRunCallLedger(LEASE);

    const [url] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(url).toBe(
      "https://backend.test/internal/v1/claude-readiness/runs/calls?runId=run_1&jobId=job_1",
    );
    expect(ledger.testPlanRevision).toBe(3);
    expect(ledger.calls).toEqual([
      expect.objectContaining({ planRevision: 3 }),
    ]);
  });

  it("reports a run that names no plan", async () => {
    answer({ ok: true, calls: [] });
    expect(await readRunCallLedger(LEASE)).toEqual({ calls: [] });
  });

  it("refuses a ledger with a call it cannot read: it may be a write that landed", async () => {
    answer({
      ok: true,
      testPlanRevision: 3,
      calls: [{ ...ROW, phase: "sent" }],
    });
    await expect(readRunCallLedger(LEASE)).rejects.toThrow(/could not be read/);
  });
});

describe("readRunTestPlan", () => {
  it("reads the frozen revision, or nothing when it is no longer kept", async () => {
    const plan = { schemaVersion: 1 };
    answer({ ok: true, submissionId: "sub_1", revision: 3, plan });
    expect(await readRunTestPlan(LEASE)).toEqual({ revision: 3, plan });
    answer({ ok: false, error: "no_test_plan" }, 404);
    expect(await readRunTestPlan(LEASE)).toBeUndefined();
  });
});

describe("toCallRecord", () => {
  it("keeps only what the SDK's record holds, with the client checked", () => {
    expect(
      toCallRecord({ ...ROW, ranBy: { kind: "eval-run", client: "claude" } }),
    ).toMatchObject({ ranBy: { kind: "eval-run", client: "claude" } });
    expect(
      toCallRecord({ ...ROW, ranBy: { kind: "someone" } }),
    ).toBeUndefined();
    expect(toCallRecord(ROW)).not.toHaveProperty("effect");
    expect(toCallRecord(ROW)).not.toHaveProperty("attempts");
  });
});
