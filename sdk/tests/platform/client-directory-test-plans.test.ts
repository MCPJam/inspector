import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  directorySubmissionConflict,
  directoryTestPlanSchema,
} from "../../src/platform/index.js";
import { draftDirectoryTestPlan } from "../../src/directory-readiness/test-plan/index.js";

const ONE = "/api/v1/projects/project-1/directory-submissions/sub-1";
const SCOPE = { projectId: "project-1", submissionId: "sub-1" };
const PLAN = draftDirectoryTestPlan([
  { name: "search_docs", annotations: { readOnlyHint: true } },
]);

/** A client that records each request and answers with `answer`. */
function recordingClient(answer: () => Response = () => Response.json({})) {
  const requests: Array<{
    key: string;
    query: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      key: `${init?.method ?? "GET"} ${url.pathname}`,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return answer();
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

describe("directory test plan client methods", () => {
  it("call each route with the query or body it takes", async () => {
    const { client, requests } = recordingClient();
    await client.getDirectorySubmissionTestPlan(SCOPE);
    await client.getDirectorySubmissionTestPlan({ ...SCOPE, revision: 2 });
    await client.draftDirectorySubmissionTestPlan(SCOPE);
    await client.saveDirectorySubmissionTestPlan({
      ...SCOPE,
      expectedRevision: 0,
      plan: PLAN,
    });
    await client.getDirectorySubmissionToolTests(SCOPE);
    await client.getDirectorySubmissionToolTests({ ...SCOPE, runId: "run-1" });
    expect(requests.map(({ key, query }) => [key, query])).toEqual([
      [`GET ${ONE}/test-plan`, {}],
      [`GET ${ONE}/test-plan`, { revision: "2" }],
      [`GET ${ONE}/test-plan/draft`, {}],
      [`PUT ${ONE}/test-plan`, {}],
      [`GET ${ONE}/tool-tests`, {}],
      [`GET ${ONE}/tool-tests`, { runId: "run-1" }],
    ]);
    expect(requests[3]!.body).toEqual({ expectedRevision: 0, plan: PLAN });
  });

  it("saves only the fields the strict body takes", async () => {
    const { client, requests } = recordingClient();
    const extra = { title: "never sent" };
    await client.saveDirectorySubmissionTestPlan({
      ...SCOPE,
      expectedRevision: 2,
      plan: PLAN,
      ...extra,
    });
    expect(requests[0]!.body).not.toHaveProperty("title");
  });

  it("starts a run with the plan revision it names", async () => {
    const { client, requests } = recordingClient();
    await client.startDirectorySubmissionRun({ ...SCOPE, testPlanRevision: 3 });
    expect(requests[0]).toMatchObject({
      key: `POST ${ONE}/runs`,
      body: { testPlanRevision: 3 },
    });
  });

  it("reads the current revision off a refused save", async () => {
    const refusal = {
      code: "CONFLICT",
      message: "The test plan changed since you read it.",
      details: { currentRevision: 4 },
    };
    const { client } = recordingClient(() =>
      Response.json(refusal, { status: 409 })
    );
    const error = await client
      .saveDirectorySubmissionTestPlan({
        ...SCOPE,
        expectedRevision: 2,
        plan: PLAN,
      })
      .catch((caught: unknown) => caught);
    expect(directorySubmissionConflict(error)).toEqual({
      currentRevision: 4,
      conflictingKeys: [],
    });
  });

  it("accepts a drafted plan and refuses a misspelled key", () => {
    expect(directoryTestPlanSchema.safeParse(PLAN).success).toBe(true);
    const misspelled = { ...PLAN, cases: [{ ...PLAN.cases[0], argument: {} }] };
    expect(directoryTestPlanSchema.safeParse(misspelled).success).toBe(false);
  });
});
