import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/index.js";

const BASE = "/api/v1/projects/project-1/directory-submissions/sub-1";

/** A client that records each request and answers `{}`. */
function recordingClient() {
  const requests: Array<{ key: string; query: Record<string, string>; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      key: `${init?.method ?? "GET"} ${url.pathname}`,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({});
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

const SCOPE = { projectId: "project-1", submissionId: "sub-1" };

describe("reviewer attempt client methods", () => {
  it("call each route, sending secret names and nothing a wider object carries", async () => {
    const { client, requests } = recordingClient();
    await client.createDirectoryReviewerAttempt({
      ...SCOPE,
      passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
      username: "review@example.com",
      idempotencyKey: "k1",
      // A caller's wider object: never forwarded.
      ...({ password: "not-sent" } as object),
    });
    await client.listDirectoryReviewerAttempts({ ...SCOPE, limit: 5 });
    await client.getDirectoryReviewerAttempt({ ...SCOPE, attemptId: "att-1" });
    await client.resumeDirectoryReviewerAttempt({ ...SCOPE, attemptId: "att-1" });
    await client.cancelDirectoryReviewerAttempt({ ...SCOPE, attemptId: "att-1" });
    await client.startDirectorySubmissionRun({ ...SCOPE, reviewerAttemptId: "att-1" });

    expect(requests.map((request) => request.key)).toEqual([
      `POST ${BASE}/reviewer-attempts`,
      `GET ${BASE}/reviewer-attempts`,
      `GET ${BASE}/reviewer-attempts/att-1`,
      `POST ${BASE}/reviewer-attempts/att-1/resume`,
      `POST ${BASE}/reviewer-attempts/att-1/cancel`,
      `POST ${BASE}/runs`,
    ]);
    expect(requests[0]!.body).toEqual({
      passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
      username: "review@example.com",
      idempotencyKey: "k1",
    });
    expect(requests[1]!.query).toEqual({ limit: "5" });
    expect(requests[3]!.body).toBeUndefined();
    expect(requests[5]!.body).toEqual({ reviewerAttemptId: "att-1" });
  });

  it("encodes ids in the path", async () => {
    const { client, requests } = recordingClient();
    await client.getDirectoryReviewerAttempt({
      projectId: "p/1",
      submissionId: "s 1",
      attemptId: "a?1",
    });
    expect(requests[0]!.key).toBe(
      "GET /api/v1/projects/p%2F1/directory-submissions/s%201/reviewer-attempts/a%3F1",
    );
  });
});
