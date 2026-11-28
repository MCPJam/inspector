import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  PlatformApiError,
  directorySubmissionConflict,
} from "../../src/platform/index.js";

const ONE = "/api/v1/projects/project-1/directory-submissions/sub-1";
const SCOPE = { projectId: "project-1", submissionId: "sub-1" };

/** A client that records each request and answers with `answer`. */
function recordingClient(answer: () => Response = () => Response.json({})) {
  const requests: Array<{ key: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      key: `${init?.method ?? "GET"} ${url.pathname}${url.search}`,
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

describe("directory submission eval client methods", () => {
  it("call each route with the body it takes", async () => {
    const { client, requests } = recordingClient();
    await client.getDirectorySubmissionEvals(SCOPE);
    await client.setDirectorySubmissionEvals({ ...SCOPE, expectedRevision: 4, suiteId: "suite-1", runId: "run-1", idempotencyKey: "k" });
    await client.importDirectorySubmissionTestCases(SCOPE);
    await client.importDirectorySubmissionTestCases({ ...SCOPE, pluginVersionId: "ver-1" });
    await client.exportDirectorySubmissionTestCases(SCOPE);
    expect(requests).toEqual([
      { key: `GET ${ONE}/evals`, body: undefined },
      { key: `PATCH ${ONE}/evals`, body: { expectedRevision: 4, suiteId: "suite-1", runId: "run-1", idempotencyKey: "k" } },
      { key: `POST ${ONE}/evals/import`, body: {} },
      { key: `POST ${ONE}/evals/import`, body: { pluginVersionId: "ver-1" } },
      { key: `GET ${ONE}/evals/export`, body: undefined },
    ]);
  });

  it("keeps null, which unlinks, and sends no field the strict body does not take", async () => {
    const { client, requests } = recordingClient();
    const extra = { title: "never sent" };
    await client.setDirectorySubmissionEvals({ ...SCOPE, expectedRevision: 4, suiteId: null, ...extra });
    expect(requests[0]!.body).toEqual({ expectedRevision: 4, suiteId: null });
  });

  it("reads a stale link's refusal as a conflict", async () => {
    const refusal = {
      code: "CONFLICT",
      message: "Someone changed this submission since you read it.",
      details: { currentRevision: 7, conflictingKeys: ["evalSuite"] },
    };
    const { client } = recordingClient(() => Response.json(refusal, { status: 409 }));
    const error = await client
      .setDirectorySubmissionEvals({ ...SCOPE, expectedRevision: 4, runId: null })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect(directorySubmissionConflict(error)).toEqual({ currentRevision: 7, conflictingKeys: ["evalSuite"] });
  });
});
