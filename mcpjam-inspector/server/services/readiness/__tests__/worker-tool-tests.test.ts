/**
 * A submission run's tool tests and its reviewer path, through the real
 * worker, runner, reviewer path, test plan run and ledger client, with
 * MCPJam's backend and the target server stubbed.
 *
 * The plan runs as the reviewer account and on no other credential; a run
 * without one calls nothing and says why (RP2). A fixture the reviewer path
 * looked up and did not find blocks the cases that use it, and only those
 * (RP5). The grade's own checks keep the run's credential, as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryTestPlan, OpenAISubmissionMode } from "@mcpjam/sdk";
import { executeHostedReadinessRun } from "../worker.js";
import type { ReadinessReviewerAccount } from "../reviewer-path.js";
import type { DirectoryToolTestReport } from "../test-plan-run.js";
import { TOOLS, samplePlan } from "./test-plan-fixtures.js";

const LEASE = { runId: "run_1", jobId: "job_1" };
const TARGET = "https://connector.example.com/mcp";
const STAFF = "Bearer staff-token";
const REVIEWER = "Bearer reviewer-token";
const AS_REVIEWER: ReadinessReviewerAccount = {
  accountId: "acct_reviewer",
  mcpHeaders: { authorization: REVIEWER },
};
const NO_ACCOUNT =
  "No reviewer account is connected for this submission. Rehearse the reviewer sign-in, then run again.";
const FIXTURE_MISSING =
  "demoProject was not found in the reviewer's account. Add it there, or update the fixture.";

const WHOAMI = {
  name: "whoami",
  annotations: { readOnlyHint: true },
  inputSchema: { type: "object", properties: {} },
};

type Engine = "claude" | "openai";
/** Each directory keeps the reviewer section under its own step. */
const ENGINES: Record<
  Engine,
  { flowId: string; step: string; submissionMode?: OpenAISubmissionMode }
> = {
  claude: { flowId: "claude-connector", step: "testLaunch" },
  openai: {
    flowId: "chatgpt-plugin",
    step: "reviewer",
    submissionMode: "mcp-only",
  },
};

/** The reviewer section: who the reviewer is, and the project the plan reads. */
function answers(engine: Engine) {
  const answer = (name: string, value: unknown) => ({
    key: `${ENGINES[engine].step}.${name}`,
    value,
    origin: "set",
  });
  return [
    answer("identityTool", "whoami"),
    answer("expectedIdentityPath", "$.user.email"),
    answer("expectedIdentity", "review@example.com"),
    answer("expectedOrganizationPath", "$.organization.name"),
    answer("expectedOrganization", "Sample Org"),
    answer("fixtures", [{ fixture: "proj_demo", lookup: "list_projects" }]),
  ];
}

/** The sample plan, covering the identity tool the server also lists. */
function plan(): DirectoryTestPlan {
  const sample = samplePlan();
  return {
    ...sample,
    tools: [
      ...sample.tools,
      {
        tool: "whoami",
        effect: "read",
        openWorld: false,
        action: "run",
        writes: [],
      },
    ],
    cases: [
      { id: "whoami#valid", tool: "whoami", kind: "valid", arguments: {} },
      ...sample.cases,
    ],
  };
}

interface Seen {
  rpc: string;
  tool?: string;
  args?: Record<string, unknown>;
  authorization: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Who the reviewer token signs in as: the account the answers name. */
const NAMED_REVIEWER = {
  user: { email: "review@example.com" },
  organization: { name: "Sample Org" },
};

/** The target server: lists the sample tools, and holds `projects` for each account. */
function connector(projects: string[], reviewerIs = NAMED_REVIEWER) {
  const seen: Seen[] = [];
  const identity = (authorization: string | null) =>
    authorization === REVIEWER
      ? reviewerIs
      : {
          user: { email: "staff@example.com" },
          organization: { name: "Staff Org" },
        };
  const called = (
    name: string,
    args: Record<string, unknown>,
    authorization: string | null,
  ) => {
    if (name === "whoami")
      return { content: [], structuredContent: identity(authorization) };
    if (name === "list_projects") {
      return {
        content: [],
        structuredContent: { projects: projects.map((id) => ({ id })) },
      };
    }
    if (name === "create_project") {
      return {
        content: [],
        structuredContent: { project: { id: "proj_scratch" } },
      };
    }
    const refused = name === "get_project" && !args.projectId;
    return { content: [{ type: "text", text: "done" }], isError: refused };
  };
  const fetchFn: typeof fetch = async (_input, init) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const authorization = new Headers(init?.headers).get("authorization");
    const { name, arguments: args } = body.params ?? {};
    seen.push({ rpc: body.method, tool: name, args, authorization });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
      "tools/list": { tools: [...TOOLS, WHOAMI] },
      "resources/list": { resources: [] },
    };
    const result =
      body.method === "tools/call"
        ? called(name, args ?? {}, authorization)
        : results[String(body.method)];
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
  return {
    fetchFn,
    seen,
    calls: () => seen.filter((entry) => entry.rpc === "tools/call"),
  };
}

interface Backend {
  /** Calls written to the run's ledger. */
  recorded: Array<Record<string, unknown>>;
  /** Whether the run read its test plan. */
  planRead: boolean;
  /** Finalize and fail bodies. */
  writes: Array<{
    outcome?: string;
    report?: {
      toolTests?: DirectoryToolTestReport;
      findings?: Array<{
        id: string;
        status: string;
        notEvaluatedReason?: string;
      }>;
    };
  }>;
}

/** The reviewer checks of the one report the run finalized. */
function reviewerChecks(backend: Backend) {
  const findings = backend.writes[0]?.report?.findings ?? [];
  return ["both.reviewer.identity", "both.reviewer.fixtures"].map((id) =>
    findings.find((finding) => finding.id === id),
  );
}

/** MCPJam's backend for a submission run whose start named the plan. */
function stubBackend(
  engine: Engine = "claude",
  /** Answers beyond the reviewer section. */
  more: Array<{ key: string; value: unknown; origin: string }> = [],
): Backend {
  const backend: Backend = { recorded: [], planRead: false, writes: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path.endsWith("/runs/claim"))
        return json({ ok: true, claimed: true });
      if (path.endsWith("/runs/heartbeat"))
        return json({ ok: true, alive: true });
      if (path.endsWith("/runs/submission")) {
        return json({
          ok: true,
          submissionId: "sub_1",
          submissionRevision: 4,
          flowId: ENGINES[engine].flowId,
          flowVersion: "1",
          answers: [...answers(engine), ...more],
        });
      }
      if (path.endsWith("/runs/test-plan")) {
        backend.planRead = true;
        return json({ ok: true, revision: 3, plan: plan() });
      }
      if (path.endsWith("/runs/calls") && !body) {
        return json({ ok: true, testPlanRevision: 3, calls: [] });
      }
      if (path.endsWith("/runs/calls")) {
        backend.recorded.push(body.call);
        return json({ ok: true, call: body.call });
      }
      backend.writes.push(body);
      return json({ ok: true, applied: true });
    }),
  );
  return backend;
}

function run(
  fetchFn: typeof fetch,
  reviewer?: ReadinessReviewerAccount,
  engine: Engine = "claude",
) {
  return executeHostedReadinessRun({
    lease: LEASE,
    publisher: engine,
    submissionMode: ENGINES[engine].submissionMode,
    target: TARGET,
    fetchFn,
    // The requester's credential: the grade's own checks use it.
    mcpHeaders: { authorization: STAFF },
    includeLlmObservations: false,
    submissionId: "sub_1",
    ...(reviewer ? { reviewer } : {}),
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

const caseStatuses = (report: DirectoryToolTestReport) =>
  Object.fromEntries(
    report.tools.flatMap((tool) =>
      tool.cases.map((result) => [result.caseId, result.status]),
    ),
  );

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("a submission run's tool tests, with a reviewer account", () => {
  it("lists and calls every tool as the reviewer, and records the account with each call", async () => {
    const backend = stubBackend();
    const server = connector(["proj_demo"]);
    await run(server.fetchFn, AS_REVIEWER);

    const report = toolTests(backend);
    expect(report).toMatchObject({
      planRevision: 3,
      status: "completed",
      ambiguous: [],
    });
    // The sweep's calls are the plan's, as the reviewer and never as the requester.
    const sweep = server.calls().map((call) => call.tool);
    for (const tool of [
      "list_projects",
      "get_project",
      "create_project",
      "rename_project",
      "delete_project",
    ]) {
      expect(sweep).toContain(tool);
    }
    expect(
      server.calls().every((call) => call.authorization === REVIEWER),
    ).toBe(true);
    expect(backend.recorded.length).toBeGreaterThan(0);
    expect(
      backend.recorded.every((call) => call.account === "acct_reviewer"),
    ).toBe(true);
    expect(
      report.tools.find((tool) => tool.tool === "get_project")?.cases[0]?.call,
    ).toMatchObject({
      account: "acct_reviewer",
      ranBy: { kind: "direct-call" },
    });
    // Unchanged: the grade's own checks still dial with the run's credential.
    expect(
      server.seen.some(
        (entry) => entry.rpc === "tools/list" && entry.authorization === STAFF,
      ),
    ).toBe(true);
  });
});

describe("a submission run's tool tests, without a reviewer account", () => {
  it.each([
    ["the start's reason", { missing: NO_ACCOUNT }, NO_ACCOUNT],
    [
      "no account at all",
      undefined,
      "This run was started without the reviewer account. Start a new run from the submission.",
    ],
  ])(
    "blocks them with %s, and the server sees no call",
    async (_label, reviewer, reason) => {
      const backend = stubBackend();
      const server = connector(["proj_demo"]);
      await run(server.fetchFn, reviewer);

      expect(toolTests(backend)).toEqual({
        planRevision: 3,
        status: "not-run",
        reason,
        ambiguous: [],
        tools: [],
        cleanup: [],
      });
      expect(server.calls()).toEqual([]);
      expect(backend.recorded).toEqual([]);
      expect(backend.planRead).toBe(false);
      // Only the grade dialled, as before: with the run's credential, or none
      // for its own sign-in probe. Nothing went out as anyone else.
      const credentials = new Set(
        server.seen.map((entry) => entry.authorization),
      );
      expect(credentials).toEqual(new Set([STAFF, null]));
      expect(server.seen.some((entry) => entry.rpc === "tools/list")).toBe(
        true,
      );
    },
  );
});

describe("a reviewer account signed in as someone else", () => {
  it.each([
    [
      "another account",
      { ...NAMED_REVIEWER, user: { email: "other@example.com" } },
      "The reviewer account signed in as a different account than the submission names, so MCPJam made none of the test plan's calls. Rehearse the reviewer sign-in with the account the submission names, then start a new run.",
    ],
    [
      "another organization",
      { ...NAMED_REVIEWER, organization: { name: "Other Org" } },
      "The reviewer account answers for an organization other than the one the submission names, so MCPJam made none of the test plan's calls. Leave the reviewer account in only the organization or project the submission names, then start a new run.",
    ],
  ])(
    "tests no tool when it answers for %s",
    async (_label, reviewerIs, reason) => {
      const backend = stubBackend();
      const server = connector(["proj_demo"], reviewerIs);
      await run(server.fetchFn, AS_REVIEWER);

      expect(toolTests(backend)).toEqual({
        planRevision: 3,
        status: "not-run",
        reason,
        ambiguous: [],
        tools: [],
        cleanup: [],
      });
      // The identity check is the reviewer account's only call.
      expect(
        server.calls().map((call) => [call.tool, call.authorization]),
      ).toEqual([["whoami", REVIEWER]]);
      expect(backend.recorded).toEqual([]);
      expect(backend.planRead).toBe(false);
    },
  );
});

describe("a fixture the reviewer path did not find", () => {
  it.each([
    ["a Claude connector", "claude"],
    ["a ChatGPT plugin", "openai"],
  ] as const)(
    "blocks exactly the cases that use it, naming it, on %s submission",
    async (_label, engine) => {
      const found = stubBackend(engine);
      const withFixture = connector(["proj_demo"]);
      await run(withFixture.fetchFn, AS_REVIEWER, engine);
      const control = toolTests(found);
      vi.unstubAllGlobals();

      const backend = stubBackend(engine);
      const server = connector(["proj_other"]);
      await run(server.fetchFn, AS_REVIEWER, engine);
      const report = toolTests(backend);

      const getProject = report.tools.find(
        (tool) => tool.tool === "get_project",
      );
      expect(
        getProject?.cases.find(
          (result) => result.caseId === "get_project#valid",
        ),
      ).toEqual({
        caseId: "get_project#valid",
        kind: "valid",
        status: "blocked",
        reason: FIXTURE_MISSING,
      });
      expect(getProject?.status).toBe("setup-blocked");
      // Never sent: the server saw no call for the missing project.
      const reads = (calls: Seen[]) =>
        calls.filter(
          (call) => call.tool === "get_project" && call.args?.projectId,
        );
      expect(reads(withFixture.calls())).toHaveLength(1);
      expect(reads(server.calls())).toEqual([]);
      // Every other case ended as it did with the fixture there.
      const { "get_project#valid": blocked, ...rest } = caseStatuses(report);
      const { "get_project#valid": passed, ...controlRest } =
        caseStatuses(control);
      expect([passed, blocked]).toEqual(["passed", "blocked"]);
      expect(rest).toEqual(controlRest);
      expect(report.status).toBe("completed");
      expect(report.cleanup).toEqual([
        expect.objectContaining({
          callKey: "cleanup:scratchProject",
          phase: "succeeded",
        }),
      ]);
    },
  );
});

describe("a submission that says its server needs no sign-in", () => {
  const NONE = [
    { key: "authentication.requirement", value: "none", origin: "set" },
  ];

  it.each([
    ["without a reviewer account", undefined, ["proj_demo"]],
    // Its lookup misses a fixture, which no case is blocked for.
    ["with a reviewer account too", AS_REVIEWER, ["proj_other"]],
  ])(
    "tests every tool with no credential, %s, and records no account",
    async (_label, reviewer, projects) => {
      const backend = stubBackend("claude", NONE);
      const server = connector(projects);
      await run(server.fetchFn, reviewer);

      const report = toolTests(backend);
      expect(report).toMatchObject({ planRevision: 3, status: "completed" });
      // The plan's calls carry no credential, the requester's least of all.
      // Only the reviewer checks use a reviewer account, as before (P4).
      const credentialed = server
        .calls()
        .filter((call) => call.authorization !== null)
        .map((call) => [call.tool, call.authorization]);
      expect(credentialed).toEqual(
        reviewer
          ? [
              ["whoami", REVIEWER],
              ["list_projects", REVIEWER],
            ]
          : [],
      );
      const sweep = server
        .calls()
        .filter((call) => call.authorization === null)
        .map((call) => call.tool);
      expect(sweep).toEqual([
        "whoami",
        "list_projects",
        "get_project",
        "get_project",
        "create_project",
        "rename_project",
        "delete_project",
        "delete_project",
      ]);
      expect(backend.recorded.length).toBeGreaterThan(0);
      expect(backend.recorded.every((call) => !("account" in call))).toBe(true);
      // The reviewer checks do not apply, and nothing asks for a sign-in the
      // server does not have.
      for (const check of reviewerChecks(backend)) {
        expect(check).toMatchObject({
          status: "not-applicable",
          notEvaluatedReason:
            "The submission says the server needs no sign-in, so there is no reviewer account to check.",
        });
      }
      expect(JSON.stringify(backend.writes)).not.toMatch(/rehears/i);
    },
  );
});

describe("a submission that says its server needs a sign-in", () => {
  it.each([
    ["Claude, always", "claude", "always"],
    ["Claude, when the server asks", "claude", "when-asked"],
    ["ChatGPT, whose form has no such answer", "openai", undefined],
  ] as const)(
    "still tests no tool without a reviewer account: %s",
    async (_label, engine, requirement) => {
      const more = requirement
        ? [
            {
              key: "authentication.requirement",
              value: requirement,
              origin: "set",
            },
          ]
        : [];
      const backend = stubBackend(engine, more);
      const server = connector(["proj_demo"]);
      await run(server.fetchFn, { missing: NO_ACCOUNT }, engine);

      expect(toolTests(backend)).toMatchObject({
        status: "not-run",
        reason: NO_ACCOUNT,
        tools: [],
      });
      expect(server.calls()).toEqual([]);
      expect(backend.recorded).toEqual([]);
      // The reviewer checks still say to rehearse the sign-in.
      for (const check of reviewerChecks(backend)) {
        expect(check).toMatchObject({
          status: "not-evaluated",
          notEvaluatedReason: `blocked: ${NO_ACCOUNT}`,
        });
      }
    },
  );
});
