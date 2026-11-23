import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  directorySubmissionConflict,
  draftDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionToolTestsOperation,
  saveDirectorySubmissionTestPlanOperation,
  startDirectorySubmissionRunOperation,
} from "../../src/platform/index.js";
import { draftDirectoryTestPlan } from "../../src/directory-readiness/test-plan/index.js";

const PROJECT = { id: "project-1", name: "Acme", organizationId: "org-a", createdAt: 1, updatedAt: 2 };
const PROJECT_INFO = { id: "project-1", name: "Acme", organizationId: "org-a" };
const BASE = "/api/v1/projects/project-1/directory-submissions/sub-1";
const PLAN = draftDirectoryTestPlan([{ name: "search_docs", annotations: { readOnlyHint: true } }]);
const SAVED = { submissionId: "sub-1", revision: 3, counts: { tools: 1, cases: 1, fixtures: 0, cleanup: 0 }, savedBy: "user-1", savedAt: 9 };
const CATALOG = { revisionNumber: 7, capturedAt: 40 };

type Route = { body: unknown; status?: number };

/** A client whose API answers from `routes`, recording each call. */
function clientWith(routes: Record<string, Route>) {
  const requests: Array<{ key: string; query: Record<string, string>; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

const counts = (status: string) => ({ passed: 0, failed: 0, ambiguous: 0, blocked: 0, untested: 0, stale: 0, [status]: 1 });
const call = { callKey: "c", tool: "t", phase: "succeeded", inputDigest: "d", ranBy: { kind: "direct-call" } };
const tool = (name: string, status: string, caseStatus: string) => ({
  tool: name,
  status,
  validInput: counts(caseStatus),
  negative: counts("passed"),
  cases: [{ caseId: `${name}#valid`, kind: "valid", status: caseStatus, call: { ...call, tool: name } }],
});
const TOOL_TESTS = {
  run: { id: "run-1", testPlanRevision: 3 },
  testPlanRevision: 3,
  tools: [
    tool("search_docs", "valid-input-succeeded", "passed"),
    tool("create_note", "unexpected-failure", "failed"),
    tool("delete_note", "ambiguous", "ambiguous"),
    { tool: "list_projects", status: "excluded", reason: "costly", validInput: counts("passed"), negative: counts("passed"), cases: [] },
  ],
  counts: {},
  inDoubt: [{ ...call, callKey: "delete_note#valid", phase: "started" }],
  cleanup: [],
};

describe("directory test plan operations", () => {
  it("reads the current plan, or the revision named", async () => {
    const view = { ...SAVED, plan: PLAN, issues: [], catalog: CATALOG };
    const { client, requests } = clientWith({ [`GET ${BASE}/test-plan`]: { body: view } });
    const result = await getDirectorySubmissionTestPlanOperation.execute({ submission: "sub-1", revision: 2 }, { client });
    expect(requests[0]!.query).toEqual({ revision: "2" });
    expect(result).toEqual({ project: PROJECT_INFO, ...view });
  });

  it("drafts without saving, with the revision to save the draft at", async () => {
    const draft = { plan: PLAN, issues: [], catalog: CATALOG, currentRevision: 2 };
    const { client, requests } = clientWith({ [`GET ${BASE}/test-plan/draft`]: { body: draft } });
    const result = await draftDirectorySubmissionTestPlanOperation.execute({ submission: "sub-1" }, { client });
    expect(requests.map((request) => request.key)).toEqual([`GET ${BASE}/test-plan/draft`]);
    expect(result).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", ...draft });
  });

  it("saves at the revision the caller read, and never reads one for it", async () => {
    const { client, requests } = clientWith({
      [`PUT ${BASE}/test-plan`]: { body: { ...SAVED, issues: [], catalog: CATALOG } },
    });
    const result = await saveDirectorySubmissionTestPlanOperation.execute(
      { submission: "sub-1", expectedRevision: 2, plan: PLAN },
      { client }
    );
    expect(requests.map((request) => request.key)).toEqual([`PUT ${BASE}/test-plan`]);
    expect(requests[0]!.body).toEqual({ expectedRevision: 2, plan: PLAN });
    expect(result).toMatchObject({ project: PROJECT_INFO, revision: 3, catalog: CATALOG });
  });

  it("passes a stale save's refusal on with the current revision", async () => {
    const refusal = { code: "CONFLICT", message: "The test plan changed since you read it.", details: { currentRevision: 4 } };
    const { client } = clientWith({ [`PUT ${BASE}/test-plan`]: { body: refusal, status: 409 } });
    const error = await saveDirectorySubmissionTestPlanOperation
      .execute({ submission: "sub-1", expectedRevision: 2, plan: PLAN }, { client })
      .catch((caught: unknown) => caught);
    expect(directorySubmissionConflict(error)?.currentRevision).toBe(4);
  });

  it("requires the revision read, and a plan in the plan's shape", () => {
    const { inputSchema } = saveDirectorySubmissionTestPlanOperation;
    expect(inputSchema.safeParse({ submission: "sub-1", plan: PLAN }).success).toBe(false);
    expect(inputSchema.safeParse({ submission: "sub-1", expectedRevision: 0, plan: { ...PLAN, tools: "all" } }).success).toBe(false);
    expect(inputSchema.safeParse({ submission: "sub-1", expectedRevision: 0, plan: PLAN }).success).toBe(true);
  });

  it("starts a run with the plan revision named, and never fills one in", async () => {
    const { client, requests } = clientWith({ [`POST ${BASE}/runs`]: { body: { runId: "run-2" }, status: 202 } });
    await startDirectorySubmissionRunOperation.execute({ submission: "sub-1", testPlanRevision: 3 }, { client });
    await startDirectorySubmissionRunOperation.execute({ submission: "sub-1" }, { client });
    expect(requests.map((request) => request.body)).toEqual([{ testPlanRevision: 3 }, {}]);
  });
});

describe("get_directory_submission_tool_tests", () => {
  const read = (input: Record<string, string>) => {
    const { client, requests } = clientWith({ [`GET ${BASE}/tool-tests`]: { body: TOOL_TESTS } });
    const result = getDirectorySubmissionToolTestsOperation.execute({ submission: "sub-1", ...input }, { client });
    return { result, requests };
  };

  it("lists the tools that need attention, without call records, and names the calls in doubt", async () => {
    const { result, requests } = read({ run: "run-1" });
    const body = await result;
    expect(requests[0]!.query).toEqual({ runId: "run-1" });
    expect(body.tools.map((entry) => entry.tool)).toEqual(["create_note", "delete_note"]);
    expect(body.tools.flatMap((entry) => entry.cases).some((entry) => "call" in entry)).toBe(false);
    expect(body.inDoubt.map((record) => record.callKey)).toEqual(["delete_note#valid"]);
    expect(body).toMatchObject({ project: PROJECT_INFO, submissionId: "sub-1", testPlanRevision: 3 });
  });

  it("lists the tools with the status asked for", async () => {
    const body = await read({ status: "excluded" }).result;
    expect(body.tools.map((entry) => entry.tool)).toEqual(["list_projects"]);
  });

  it("reads one tool with its call records, and names a tool the plan does not have", async () => {
    const one = await read({ tool: "search_docs" }).result;
    expect(one.tools).toEqual([TOOL_TESTS.tools[0]]);
    await expect(read({ tool: "send_invoice" }).result).rejects.toThrow(/send_invoice is not in this run's test plan/);
  });
});
