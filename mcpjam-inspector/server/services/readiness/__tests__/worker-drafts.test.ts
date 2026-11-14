/**
 * Drafting test arguments through a hosted submission run: the real worker,
 * test plan run, ledger and drafting clients and SDK, with MCPJam's backend
 * and the target server stubbed. A run that opted in asks once, before the
 * sweep, for the plan's cases without arguments and reports the drafts. It
 * never sends them, and a lost lease stops it. All sample text is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryTestPlan } from "@mcpjam/sdk";
import { executeHostedReadinessRun } from "../worker.js";
import type { TestArgumentDraftItem } from "../test-argument-drafts.js";
import type { DirectoryToolTestReport } from "../test-plan-run.js";
import { TOOLS, samplePlan } from "./test-plan-fixtures.js";

const LEASE = { runId: "run_1", jobId: "job_1" };
const TARGET = "https://connector.example.com/mcp";
const TO_DRAFT = [
  "get_project#valid",
  "rename_project#valid",
  "delete_project#valid",
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** What the broker answers for the three cases. */
const DRAFTED = {
  ok: true,
  status: "completed",
  detail: "1 of 3 cases came back without arguments",
  drafts: [
    {
      caseId: "get_project#valid",
      arguments: { projectId: { $fixture: "demoProject", value: "id" } },
      rationale: "Reads the project the account starts with.",
    },
    {
      caseId: "rename_project#valid",
      arguments: {
        projectId: { $fixture: "scratchProject", value: "id" },
        name: "Sample Project",
      },
      rationale: "Renames the project the sweep creates.",
    },
  ],
  undecided: [
    {
      caseId: "delete_project#valid",
      reason: "unclear",
      detail: "The description does not say what deleting needs.",
    },
  ],
  dropped: { schema: 0, credential: 0 },
  modelId: "sample-model",
  promptVersion: "1",
};

/** The sample plan with three cases' arguments left to draft. */
function planToDraft(): DirectoryTestPlan {
  const plan = samplePlan();
  const cases = plan.cases.map(({ arguments: args, ...testCase }) =>
    TO_DRAFT.includes(testCase.id)
      ? testCase
      : { ...testCase, arguments: args },
  );
  return { ...plan, cases };
}

/** The target server, answering the grade and the test plan; it notes each tool called. */
function targetServer() {
  const called: string[] = [];
  const tools = TOOLS.map((tool) => ({
    ...tool,
    description: `What ${tool.name} does.`,
  }));
  const table: Record<string, unknown> = {
    initialize: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "demo", version: "1" },
    },
    "tools/list": { tools },
    "resources/list": { resources: [] },
  };
  const fetchFn: typeof fetch = async (_input, init) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "tools/call") called.push(body.params.name);
    const result =
      body.method === "tools/call"
        ? {
            content: [],
            structuredContent: { project: { id: "proj_scratch" } },
          }
        : table[String(body.method)];
    return json(
      result === undefined
        ? {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "unknown method" },
          }
        : { jsonrpc: "2.0", id: body.id, result },
    );
  };
  return { fetchFn, called };
}

interface Backend {
  /** Bodies sent to the drafting route. */
  asked: Array<{
    runId: string;
    jobId: string;
    items: TestArgumentDraftItem[];
  }>;
  /** Calls written to the run's ledger. */
  recorded: unknown[];
  /** Finalize and fail bodies. */
  writes: Array<{
    outcome?: string;
    report?: { toolTests?: DirectoryToolTestReport };
  }>;
}

/** MCPJam's backend for a submission run whose start named `plan`. */
function stubBackend(
  plan: DirectoryTestPlan,
  draft: () => Response | Promise<Response>,
): Backend {
  const backend: Backend = { asked: [], recorded: [], writes: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path.endsWith("/runs/claim"))
        return json({ ok: true, claimed: true });
      if (path.endsWith("/runs/heartbeat"))
        return json({ ok: true, alive: true });
      if (path.endsWith("/observations")) {
        return json({ ok: false, error: "observations_disabled" }, 403);
      }
      if (path.endsWith("/runs/submission")) {
        return json({
          ok: true,
          submissionId: "sub_1",
          submissionRevision: 4,
          flowId: "claude-connector",
          flowVersion: "1",
          answers: [],
        });
      }
      if (path.endsWith("/runs/test-plan")) {
        return json({ ok: true, revision: 3, plan });
      }
      if (path.endsWith("/runs/calls") && !body) {
        return json({ ok: true, testPlanRevision: 3, calls: [] });
      }
      if (path.endsWith("/runs/calls")) {
        backend.recorded.push(body.call);
        return json({ ok: true, call: body.call });
      }
      if (path.endsWith("/test-arguments")) {
        backend.asked.push(body);
        return draft();
      }
      backend.writes.push(body);
      return json({ ok: true, applied: true });
    }),
  );
  return backend;
}

let server: ReturnType<typeof targetServer>;

function run(includeLlmObservations = true) {
  return executeHostedReadinessRun({
    lease: LEASE,
    publisher: "claude",
    target: TARGET,
    fetchFn: server.fetchFn,
    includeLlmObservations,
    submissionId: "sub_1",
    // A plan runs as the reviewer account or not at all.
    reviewer: {
      accountId: "acct_reviewer",
      mcpHeaders: { authorization: "Bearer reviewer-token" },
    },
  });
}

/** The tool tests of the one report the run finalized. */
function toolTests(backend: Backend): DirectoryToolTestReport {
  expect(backend.writes).toHaveLength(1);
  const [write] = backend.writes;
  expect(write?.outcome).toBeUndefined();
  expect(write?.report?.toolTests).toBeDefined();
  return write!.report!.toolTests!;
}

/** Runs to the first drafting request, then lets `ms` of retries pass. */
async function runWaiting(backend: Backend, ms: number) {
  vi.useFakeTimers();
  const finished = run();
  await vi.waitFor(() => expect(backend.asked).not.toHaveLength(0), {
    timeout: 10_000,
  });
  await vi.advanceTimersByTimeAsync(ms);
  await finished;
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
  server = targetServer();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("a hosted run's test argument drafting", () => {
  it("asks once, on the run's lease, and reports the drafts without sending them", async () => {
    const backend = stubBackend(planToDraft(), () => json(DRAFTED));
    await run();

    expect(backend.asked).toHaveLength(1);
    expect(backend.asked[0]).toMatchObject(LEASE);
    expect(backend.asked[0]!.items.map((item) => item.caseId)).toEqual(
      TO_DRAFT,
    );
    const report = toolTests(backend);
    expect(report.drafting).toEqual({
      status: "completed",
      detail: DRAFTED.detail,
      // Fixture references come back, and are stored, unresolved.
      drafts: DRAFTED.drafts,
      undecided: DRAFTED.undecided,
      dropped: { schema: 0, credential: 0 },
      unsent: 0,
      modelId: "sample-model",
      promptVersion: "1",
    });
    // Never sent: no tool was called, the ledger holds nothing, and the
    // cases are still undrafted in the plan this run ran.
    expect(server.called).toEqual([]);
    expect(backend.recorded).toEqual([]);
    expect(report.status).toBe("not-run");
    expect(report.issues).toEqual(
      expect.arrayContaining(
        TO_DRAFT.map((caseId) =>
          expect.objectContaining({ code: "argumentsMissing", caseId }),
        ),
      ),
    );
    const getProject = report.tools.find((tool) => tool.tool === "get_project");
    expect(
      getProject?.cases.find((result) => result.caseId === "get_project#valid"),
    ).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/not drafted/),
    });
  });

  it("asks nothing for a run that did not opt in", async () => {
    const backend = stubBackend(planToDraft(), () => json(DRAFTED));
    await run(false);

    expect(backend.asked).toEqual([]);
    const report = toolTests(backend);
    expect(report.status).toBe("not-run");
    expect(report).not.toHaveProperty("drafting");
  });

  it("asks nothing when every case has arguments, and runs the sweep", async () => {
    const backend = stubBackend(samplePlan(), () => json(DRAFTED));
    await run();

    expect(backend.asked).toEqual([]);
    const report = toolTests(backend);
    expect(report.status).toBe("completed");
    expect(server.called).toContain("create_project");
    expect(report).not.toHaveProperty("drafting");
  });

  it.each(["drafting_disabled", "drafting_not_requested"])(
    "reports nothing of drafting when the broker answers 403 %s",
    async (error) => {
      const backend = stubBackend(planToDraft(), () =>
        json({ ok: false, error }, 403),
      );
      await run();

      expect(backend.asked).toHaveLength(1);
      expect(toolTests(backend)).not.toHaveProperty("drafting");
    },
  );

  it("reports a failed pass with what to do, and still finalizes the run", async () => {
    const backend = stubBackend(
      planToDraft(),
      () => new Response("boom", { status: 500 }),
    );
    await run();

    expect(toolTests(backend).drafting).toMatchObject({
      status: "provider-failed",
      reason: "provider_error",
      detail: expect.stringMatching(/Start a new run to try again\.$/),
      drafts: [],
    });
  });

  it("waits for a pass already running for the run, and reports its drafts", async () => {
    const replies = [
      json({ ok: false, error: "drafting_in_progress" }, 409),
      json({ ok: false, error: "drafting_in_progress" }, 409),
      json({ ...DRAFTED, replayed: true }),
    ];
    const backend = stubBackend(planToDraft(), () => replies.shift()!);
    await runWaiting(backend, 60_000);

    expect(backend.asked).toHaveLength(3);
    expect(toolTests(backend).drafting?.drafts).toEqual(DRAFTED.drafts);
  });

  it("gives up on a pass that is still running after five minutes", async () => {
    const backend = stubBackend(planToDraft(), () =>
      json({ ok: false, error: "drafting_in_progress" }, 409),
    );
    await runWaiting(backend, 5 * 60_000);

    // The first request and ten retries, 30 seconds apart.
    expect(backend.asked).toHaveLength(11);
    expect(toolTests(backend).drafting).toMatchObject({
      status: "provider-failed",
      reason: "provider_timeout",
      detail: expect.stringMatching(/still being drafted after 5 minutes/),
      drafts: [],
    });
  });

  it.each([
    ["the lease is lost", () => json({ ok: false, error: "lease_lost" }, 409)],
    ["a 409 it cannot read", () => new Response("conflict", { status: 409 })],
  ])("writes nothing when %s while drafting", async (_label, answer) => {
    const backend = stubBackend(planToDraft(), answer);
    await run();

    expect(backend.asked).toHaveLength(1);
    expect(backend.writes).toEqual([]);
  });
});
