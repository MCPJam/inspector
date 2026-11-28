/**
 * A submission run's tool tests, end to end against a scripted server: the
 * plan the start named is checked against the server's live tools before
 * anything is called, executed, and reported per tool with who ran each call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  directoryTestCaseDigest,
  type DirectoryReviewerFixtureEvidence,
  type DirectoryTestCallRecord,
} from "@mcpjam/sdk";
import { ReadinessLeaseLostError } from "../runner.js";
import type { TestArgumentRequester } from "../test-argument-drafts.js";
import {
  TOOLS,
  memoryLedger,
  samplePlan,
  storedCall,
  type Journal,
} from "./test-plan-fixtures.js";

const readRunCallLedger = vi.fn();
const readRunTestPlan = vi.fn();
const recordRunCall = vi.fn();

vi.mock("../call-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../call-ledger.js")>()),
  readRunCallLedger: (...args: unknown[]) => readRunCallLedger(...args),
  readRunTestPlan: (...args: unknown[]) => readRunTestPlan(...args),
  recordRunCall: (...args: unknown[]) => recordRunCall(...args),
}));

const { runDirectoryTestPlan } = await import("../test-plan-run.js");

const LEASE = { runId: "run_1", jobId: "job_1" };
const TARGET = "https://connector.example.com/mcp?api_key=never-stored";

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  session: string | null;
}

/** An MCP server that lists `tools` and answers each call as the sample does. */
function wire(tools = TOOLS) {
  const calls: ToolCall[] = [];
  const credentials: Array<string | null> = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    credentials.push(new Headers(init?.headers).get("authorization"));
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers });
    if (body.method === "initialize") {
      return reply(
        { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
        { "mcp-session-id": "session-1" },
      );
    }
    if (body.method === "tools/list") return reply({ tools });
    if (body.method !== "tools/call")
      return new Response(null, { status: 202 });
    const { name, arguments: args } = body.params;
    calls.push({
      name,
      arguments: args,
      session: new Headers(init?.headers).get("mcp-session-id"),
    });
    if (name === "create_project") {
      return reply({
        content: [],
        structuredContent: { project: { id: "proj_scratch" } },
      });
    }
    const refused = name === "get_project" && !args.projectId;
    return reply({
      content: [{ type: "text", text: "done" }],
      isError: refused,
    });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls, credentials };
}

let journal: Journal;
let ledger: ReturnType<typeof memoryLedger>;

function arrange(calls: DirectoryTestCallRecord[] = []) {
  readRunCallLedger.mockResolvedValue({ testPlanRevision: 3, calls });
  ledger = memoryLedger(journal, calls);
  recordRunCall.mockImplementation((_lease, call) => ledger.record(call));
}

function run(
  fetchFn: typeof fetch,
  extra: Partial<Parameters<typeof runDirectoryTestPlan>[0]> = {},
) {
  return runDirectoryTestPlan({
    lease: LEASE,
    target: TARGET,
    fetchFn,
    reviewer: {
      accountId: "acct_reviewer",
      mcpHeaders: { authorization: "Bearer reviewer-token" },
    },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 15 * 60_000,
    ...extra,
  });
}

beforeEach(() => {
  journal = [];
  readRunTestPlan.mockResolvedValue({ revision: 3, plan: samplePlan() });
  arrange();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runDirectoryTestPlan", () => {
  it("tests no tools for a run whose start named no plan", async () => {
    readRunCallLedger.mockResolvedValue({ calls: [] });
    const { fetchFn } = wire();
    expect(await run(fetchFn)).toBeUndefined();
    expect(readRunTestPlan).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("runs the plan and reports each tool, a negative case apart from valid input", async () => {
    const { fetchFn, calls } = wire();
    const report = await run(fetchFn);

    expect(calls.map((call) => call.name)).toEqual([
      "list_projects",
      "get_project",
      "get_project",
      "create_project",
      "rename_project",
      "delete_project",
      "delete_project",
    ]);
    // One session, opened for the listing the plan was checked against.
    expect(new Set(calls.map((call) => call.session))).toEqual(
      new Set(["session-1"]),
    );
    expect(calls[4]?.arguments).toEqual({
      projectId: "proj_scratch",
      name: "Renamed by MCPJam",
    });
    expect(report).toMatchObject({
      planRevision: 3,
      status: "completed",
      ambiguous: [],
      cleanup: [{ callKey: "cleanup:scratchProject", phase: "succeeded" }],
    });
    const tools = Object.fromEntries(
      (report?.tools ?? []).map((result) => [result.tool, result]),
    );
    // The refusal passes as a negative case and is not valid-input coverage.
    expect(tools.get_project).toMatchObject({
      status: "valid-input-succeeded",
      validInput: { passed: 1 },
      negative: { passed: 1 },
    });
    expect(tools.send_invite).toMatchObject({ status: "excluded", cases: [] });
    expect(tools.delete_project?.status).toBe("valid-input-succeeded");
    const call = tools.list_projects?.cases[0]?.call;
    expect(call).toMatchObject({
      ranBy: { kind: "direct-call" },
      phase: "succeeded",
    });
    // The client stamps each record with the plan revision it was made under.
    expect(recordRunCall).toHaveBeenCalledWith(LEASE, expect.anything(), 3);
    // The server's URL is recorded without the key in its query.
    expect(call?.endpoint).not.toContain("never-stored");
    expect(JSON.stringify(report)).not.toContain("never-stored");
  });

  it("refuses a plan that does not match the server's tools, and calls nothing", async () => {
    const { fetchFn, calls } = wire([...TOOLS, { name: "archive_project" }]);
    const report = await run(fetchFn);

    expect(calls).toEqual([]);
    expect(recordRunCall).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      planRevision: 3,
      status: "not-run",
      reason: expect.stringMatching(
        /does not match the tools the server lists/,
      ),
    });
    // Kept readable, unlike other `code` fields a stored report blanks.
    expect(report?.issues).toEqual([
      expect.objectContaining({ code: "missingTool", tool: "archive_project" }),
    ]);
    expect(
      report?.tools.find((tool) => tool.tool === "list_projects"),
    ).toMatchObject({
      status: "setup-blocked",
    });
  });

  it("names a write an earlier worker left started, and never sends it again", async () => {
    arrange([storedCall("create_project#valid", "create_project", "digest-1")]);
    const { fetchFn, calls } = wire();
    const report = await run(fetchFn);

    expect(calls.map((call) => call.name)).not.toContain("create_project");
    expect(journal).toContain("ambiguous create_project#valid");
    expect(report?.ambiguous).toEqual(["create_project#valid"]);
    expect(
      report?.tools.find((tool) => tool.tool === "create_project")?.status,
    ).toBe("ambiguous");
  });

  it.each([
    [
      "the plan revision is no longer saved",
      () => readRunTestPlan.mockResolvedValue(undefined),
      "Test plan revision 3 is no longer saved, so no tool was called. Start a new run with the current plan.",
    ],
    [
      "the plan cannot be read",
      () => readRunTestPlan.mockRejectedValue(new Error("HTTP 503")),
      "Test plan revision 3 could not be read, so no tool was called. Start a new run.",
    ],
    [
      "the plan is not in the SDK's form",
      () =>
        readRunTestPlan.mockResolvedValue({ revision: 3, plan: { cases: [] } }),
      "Test plan revision 3 is not in a form MCPJam can run, so no tool was called. Save the plan again, then start a new run.",
    ],
    [
      "the call ledger cannot be read",
      () => readRunCallLedger.mockRejectedValue(new Error("HTTP 503")),
      "MCPJam could not read this run's call record, so no tool was called. Start a new run.",
    ],
  ])(
    "calls no tool and says why when %s",
    async (_label, arrangeFailure, reason) => {
      arrangeFailure();
      const { fetchFn } = wire();
      const report = await run(fetchFn);
      expect(report).toMatchObject({ status: "not-run", reason, tools: [] });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("calls no tool when the server's tools cannot be listed", async () => {
    const fetchFn = vi.fn(async () => new Response("down", { status: 503 }));
    const report = await run(fetchFn as unknown as typeof fetch);
    expect(report).toMatchObject({
      status: "not-run",
      reason: expect.stringMatching(
        /^The server's tool list could not be read in full/,
      ),
    });
    expect(recordRunCall).not.toHaveBeenCalled();
  });

  it("stops on a lost lease while reading the run's ledger", async () => {
    readRunCallLedger.mockRejectedValue(new ReadinessLeaseLostError());
    const { fetchFn } = wire();
    await expect(run(fetchFn)).rejects.toBeInstanceOf(ReadinessLeaseLostError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("runDirectoryTestPlan as the reviewer", () => {
  const BLOCKED =
    "demoProject was not found in the reviewer's account. Add it there, or update the fixture.";

  /** The reviewer path's lookup, with one resource it did or did not find. */
  const lookup = (
    name: string,
    status: "found" | "missing" = "missing",
  ): DirectoryReviewerFixtureEvidence => ({
    fixtures: [{ name, tool: "list_projects", status }],
    blockedCases: [],
  });

  it("lists and calls as the reviewer account only, and records it with every call", async () => {
    const { fetchFn, credentials } = wire();
    const report = await run(fetchFn);

    expect(report?.status).toBe("completed");
    expect(new Set(credentials)).toEqual(new Set(["Bearer reviewer-token"]));
    // The cleanup call as well as the cases.
    expect(ledger.writes.map((write) => write.callKey)).toContain(
      "cleanup:scratchProject",
    );
    expect(
      ledger.writes.every((write) => write.account === "acct_reviewer"),
    ).toBe(true);
  });

  it("reads no plan and lists nothing without a reviewer account", async () => {
    const reason =
      "No reviewer account is connected for this submission. Rehearse the reviewer sign-in, then run again.";
    const { fetchFn } = wire();
    const report = await run(fetchFn, { reviewer: { missing: reason } });

    expect(report).toEqual({
      planRevision: 3,
      status: "not-run",
      reason,
      ambiguous: [],
      tools: [],
      cleanup: [],
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readRunTestPlan).not.toHaveBeenCalled();
    expect(recordRunCall).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong-account",
      "The reviewer account signed in as a different account than the submission names, so MCPJam made none of the test plan's calls. Rehearse the reviewer sign-in with the account the submission names, then start a new run.",
    ],
    [
      "wrong-tenant",
      "The reviewer account answers for an organization other than the one the submission names, so MCPJam made none of the test plan's calls. Leave the reviewer account in only the organization or project the submission names, then start a new run.",
    ],
  ] as const)(
    "lists and calls nothing when the identity check found %s",
    async (outcome, reason) => {
      const { fetchFn } = wire();
      const report = await run(fetchFn, { identity: { outcome } });

      expect(report).toEqual({
        planRevision: 3,
        status: "not-run",
        reason,
        ambiguous: [],
        tools: [],
        cleanup: [],
      });
      // The server is never dialled, so nothing is listed or called.
      expect(fetchFn).not.toHaveBeenCalled();
      expect(readRunTestPlan).not.toHaveBeenCalled();
      expect(recordRunCall).not.toHaveBeenCalled();
    },
  );

  it.each(["verified", "unverified"] as const)(
    "runs the plan when the identity check is %s",
    async (outcome) => {
      const { fetchFn, calls } = wire();
      const report = await run(fetchFn, { identity: { outcome } });

      expect(report?.status).toBe("completed");
      expect(calls.map((call) => call.name)).toContain("delete_project");
    },
  );

  it.each([
    ["one of its values", lookup("proj_demo"), true],
    ["its id, in another case and with spaces", lookup(" DEMOPROJECT "), true],
    ["a resource the lookup found", lookup("proj_demo", "found"), false],
    ["a fixture the sweep creates", lookup("scratchProject"), false],
    ["a resource the plan does not use", lookup("proj_other"), false],
  ])(
    "matches a missing resource named by %s to the plan's fixture",
    async (_label, fixtures, blocks) => {
      const { fetchFn, calls } = wire();
      const report = await run(fetchFn, { fixtures });

      const sent = calls.filter(
        (call) => call.name === "get_project" && call.arguments.projectId,
      );
      expect(sent).toHaveLength(blocks ? 0 : 1);
      const results = report?.tools.flatMap((tool) => tool.cases) ?? [];
      const blocked = results.filter((result) => result.status === "blocked");
      expect(blocked).toEqual(
        blocks
          ? [
              {
                caseId: "get_project#valid",
                kind: "valid",
                status: "blocked",
                reason: BLOCKED,
              },
            ]
          : [],
      );
      // The sweep still ran, with the scratch project created and removed.
      expect(report?.status).toBe("completed");
      expect(calls.map((call) => call.name)).toContain("create_project");
    },
  );

  it("never reports a fixture the sweep creates as missing from the account", async () => {
    // The creator fails, so the cases that use its fixture are not sent.
    const { fetchFn: serve } = wire();
    const fetchFn: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.params?.name !== "create_project") return serve(url, init);
      const result = { content: [], isError: true };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    const report = await run(fetchFn, { fixtures: lookup("scratchProject") });

    const rename = report?.tools.find((tool) => tool.tool === "rename_project");
    expect(rename?.cases[0]).toMatchObject({
      status: "blocked",
      reason:
        "scratchProject was not created: case create_project#valid is failed.",
    });
  });

  it("names the missing fixture when the plan does not match the tools either", async () => {
    const { fetchFn } = wire([...TOOLS, { name: "archive_project" }]);
    const report = await run(fetchFn, { fixtures: lookup("proj_demo") });

    const getProject = report?.tools.find(
      (tool) => tool.tool === "get_project",
    );
    expect(getProject?.cases[0]).toMatchObject({
      caseId: "get_project#valid",
      status: "blocked",
      reason: BLOCKED,
    });
  });

  it("reports a call made as another reviewer account as stale", async () => {
    const plan = samplePlan();
    const testCase = plan.cases[0]!;
    const tool = TOOLS.find((entry) => entry.name === testCase.tool);
    arrange([
      storedCall(
        testCase.id,
        testCase.tool,
        directoryTestCaseDigest(plan, testCase, tool),
        { phase: "succeeded", outcome: "result", account: "acct_other" },
      ),
    ]);
    const { fetchFn } = wire();
    const report = await run(fetchFn);

    expect(
      report?.tools.find((entry) => entry.tool === testCase.tool),
    ).toMatchObject({
      status: "stale",
      reason: `${testCase.id}: It ran as another reviewer account. Run it again.`,
    });
  });
});

describe("runDirectoryTestPlan on a server that needs no sign-in", () => {
  const NO_SIGN_IN = { reviewer: { noSignIn: true as const } };

  /** A finished `list_projects#valid`, made as `account` or with none. */
  function madeAs(account?: string) {
    const plan = samplePlan();
    const testCase = plan.cases[0]!;
    const tool = TOOLS.find((entry) => entry.name === testCase.tool);
    const digest = directoryTestCaseDigest(plan, testCase, tool);
    arrange([
      storedCall(testCase.id, testCase.tool, digest, {
        phase: "succeeded",
        outcome: "result",
        ...(account ? { account } : {}),
      }),
    ]);
  }

  it("runs whatever the identity check found, since no call carries the account", async () => {
    const { fetchFn } = wire();
    const report = await run(fetchFn, {
      ...NO_SIGN_IN,
      identity: { outcome: "wrong-account" },
    });
    expect(report?.status).toBe("completed");
  });

  it("lists and calls with no credential, and records no account", async () => {
    const { fetchFn, credentials } = wire();
    const report = await run(fetchFn, NO_SIGN_IN);

    expect(report?.status).toBe("completed");
    expect(new Set(credentials)).toEqual(new Set([null]));
    expect(ledger.writes.length).toBeGreaterThan(0);
    expect(ledger.writes.every((write) => !("account" in write))).toBe(true);
    const calls = (report?.tools ?? []).flatMap((tool) =>
      tool.cases.flatMap((result) => (result.call ? [result.call] : [])),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.account === undefined)).toBe(true);
  });

  it.each([
    [
      "made as a reviewer account, once the server needs no sign-in",
      "acct_other",
      NO_SIGN_IN,
      "It ran as a reviewer account, and the submission now says the server needs no sign-in. Run it again.",
    ],
    [
      "made with no account, once there is a reviewer account",
      undefined,
      {},
      "It ran with no account, and tests now run as the reviewer account. Run it again.",
    ],
  ])("reports a result %s as stale", async (_label, account, extra, words) => {
    madeAs(account);
    const { fetchFn } = wire();
    const report = await run(fetchFn, extra);

    expect(
      report?.tools.find((tool) => tool.tool === "list_projects"),
    ).toMatchObject({
      status: "stale",
      reason: `list_projects#valid: ${words}`,
    });
  });

  it.each([
    [
      "with no sign-in, names the mismatch",
      NO_SIGN_IN,
      "The server refused a connection with no credential (HTTP 401), but the submission says it needs no sign-in, so no tool was called. Correct the authentication answer, or let the server accept calls without sign-in, then start a new run.",
    ],
    [
      "as the reviewer, says the list could not be read",
      {},
      "The server's tool list could not be read in full (Sign in first), so no tool was called. Check that the server is reachable, then start a new run.",
    ],
  ])(
    "calls no tool when the server refuses the connection: %s",
    async (_label, extra, reason) => {
      const refused = { code: -32001, message: "Sign in first" };
      const fetchFn = vi.fn(async () =>
        Response.json(
          { jsonrpc: "2.0", id: 1, error: refused },
          { status: 401 },
        ),
      );
      const report = await run(fetchFn as unknown as typeof fetch, extra);

      expect(report).toMatchObject({ status: "not-run", reason, tools: [] });
      expect(report?.reason).not.toMatch(/rehears/i);
      expect(recordRunCall).not.toHaveBeenCalled();
    },
  );

  it("drafts missing arguments with no sign-in, but not without the reviewer account", async () => {
    const plan = samplePlan();
    plan.cases = plan.cases.map(({ arguments: args, ...testCase }) =>
      testCase.id === "get_project#valid"
        ? testCase
        : { ...testCase, arguments: args },
    );
    readRunTestPlan.mockResolvedValue({ revision: 3, plan });
    const requestDrafts = vi.fn<TestArgumentRequester>(async () => undefined);

    await run(wire().fetchFn, { ...NO_SIGN_IN, requestDrafts });
    expect(requestDrafts).toHaveBeenCalledTimes(1);
    expect(requestDrafts.mock.calls[0]?.[0]).toMatchObject({
      items: [expect.objectContaining({ caseId: "get_project#valid" })],
    });

    const missing = { missing: "No reviewer account is connected." };
    await run(wire().fetchFn, { reviewer: missing, requestDrafts });
    expect(requestDrafts).toHaveBeenCalledTimes(1);
  });
});
