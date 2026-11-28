import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  exportDirectorySubmissionTestCasesOperation,
  getDirectorySubmissionEvalsOperation,
  importDirectorySubmissionTestCasesOperation,
  setDirectorySubmissionEvalsOperation,
} from "../../src/platform/index.js";

const PROJECT = { id: "project-1", name: "Acme", organizationId: "org-a", createdAt: 1, updatedAt: 2 };
const PROJECT_INFO = { id: "project-1", name: "Acme", organizationId: "org-a" };
const EVALS = "/api/v1/projects/project-1/directory-submissions/sub-1/evals";
const LINK = { submissionId: "sub-1", revision: 4, suite: { id: "suite-1", name: "Review cases" }, run: null };

type Route = { body: unknown; status?: number };

/** A client whose API answers from `routes`, recording each call. */
function clientWith(routes: Record<string, Route>) {
  const requests: Array<{ key: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    requests.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

describe("directory submission eval operations", () => {
  it("reads the link and its results in the project", async () => {
    const evals = { ...LINK, results: [], truncated: false };
    const { client } = clientWith({ [`GET ${EVALS}`]: { body: evals } });
    const result = await getDirectorySubmissionEvalsOperation.execute({ submission: "sub-1" }, { client });
    expect(result).toEqual({ project: PROJECT_INFO, ...evals });
  });

  it("links at the revision named, with a key derived from the change", async () => {
    const { client, requests } = clientWith({ [`PATCH ${EVALS}`]: { body: LINK } });
    const input = { submission: "sub-1", suite: "suite-1", expectedRevision: 4 };
    const result = await setDirectorySubmissionEvalsOperation.execute(input, { client });
    await setDirectorySubmissionEvalsOperation.execute(input, { client });
    expect(result).toEqual({ project: PROJECT_INFO, ...LINK });
    const [first, retry] = requests.map((request) => request.body as Record<string, unknown>);
    expect(first).toEqual({ expectedRevision: 4, suiteId: "suite-1", idempotencyKey: expect.stringMatching(/^derived:/) });
    // A retry of the same change is answered from the first write.
    expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it("reads the current revision first when none is named, and sends null to unlink", async () => {
    const { client, requests } = clientWith({
      [`GET ${EVALS}`]: { body: { ...LINK, revision: 9, results: [], truncated: false } },
      [`PATCH ${EVALS}`]: { body: { ...LINK, suite: null } },
    });
    await setDirectorySubmissionEvalsOperation.execute({ submission: "sub-1", suite: null, idempotencyKey: "k" }, { client });
    expect(requests.map((request) => request.key)).toEqual([`GET ${EVALS}`, `PATCH ${EVALS}`]);
    expect(requests[1]!.body).toEqual({ expectedRevision: 9, suiteId: null, idempotencyKey: "k" });
  });

  it("refuses a link that changes nothing before any request", async () => {
    const { client, requests } = clientWith({});
    await expect(
      setDirectorySubmissionEvalsOperation.execute({ submission: "sub-1", expectedRevision: 4 }, { client })
    ).rejects.toThrow(/Nothing to change/);
    expect(requests).toEqual([]);
  });

  it("imports into the linked suite, naming the version only when given", async () => {
    const imported = { suiteId: "suite-1", pluginVersionId: "ver-1", created: 0, existing: 2, cases: [], skipped: [] };
    const { client, requests } = clientWith({ [`POST ${EVALS}/import`]: { body: imported } });
    const result = await importDirectorySubmissionTestCasesOperation.execute({ submission: "sub-1" }, { client });
    await importDirectorySubmissionTestCasesOperation.execute({ submission: "sub-1", pluginVersionId: "ver-1" }, { client });
    expect(result).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", ...imported });
    expect(requests.map((request) => request.body)).toEqual([{}, { pluginVersionId: "ver-1" }]);
  });

  it("exports the file as the API serves it", async () => {
    const file = {
      submissionId: "sub-1",
      directory: "openai",
      suite: LINK.suite,
      counts: { successful: 0, gracefulFailure: 0 },
      required: { successful: 5, gracefulFailure: 3 },
      omitted: [],
      filename: "chatgpt-plugin-sub-1-test-cases.json",
      mediaType: "application/json",
      content: '{\n  "successful": [],\n  "gracefulFailure": []\n}\n',
    };
    const { client } = clientWith({ [`GET ${EVALS}/export`]: { body: file } });
    const result = await exportDirectorySubmissionTestCasesOperation.execute({ submission: "sub-1" }, { client });
    expect(result).toEqual({ project: PROJECT_INFO, ...file });
  });
});
