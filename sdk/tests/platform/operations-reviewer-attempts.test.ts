import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  cancelReviewerAttemptOperation,
  createReviewerAttemptOperation,
  getReviewerAttemptOperation,
  listReviewerAttemptsOperation,
  resumeReviewerAttemptOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const PROJECT_INFO = { id: "project-1", name: "Acme", organizationId: "org-a" };
const BASE = "/api/v1/projects/project-1/directory-submissions/sub-1/reviewer-attempts";
const ATTEMPT = {
  id: "att-1",
  submissionId: "sub-1",
  projectId: "project-1",
  serverId: "server-1",
  passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
  state: "running",
  stages: [],
  runIds: [],
  expiresAt: 10,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
};
const RUN = { runId: "run-1", status: "pending", deduped: false };
const PASSWORD = "reviewer-password-sample";

/** A client whose API answers from `routes`, recording each call. */
function clientWith(routes: Record<string, unknown>) {
  const requests: Array<{ key: string; query: Record<string, string>; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(routes[key]);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

describe("reviewer attempt operations", () => {
  it("start an attempt with secret names, and return it with its run", async () => {
    const { client, requests } = clientWith({
      [`POST ${BASE}`]: { attempt: ATTEMPT, run: RUN },
    });
    const scopes: unknown[] = [];
    const result = await createReviewerAttemptOperation.execute(
      {
        submission: "sub-1",
        passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
        username: "review@example.com",
        idempotencyKey: "k1",
      },
      { client, onScopeResolved: (scope) => scopes.push(scope) }
    );
    expect(requests[0]!.body).toEqual({
      passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
      username: "review@example.com",
      idempotencyKey: "k1",
    });
    expect(result).toEqual({
      project: PROJECT_INFO,
      submissionId: "sub-1",
      attempt: ATTEMPT,
      run: RUN,
    });
    expect(scopes).toEqual([{ projectId: "project-1", organizationId: "org-a" }]);
  });

  it("refuse a credential value under any key they do not name, quoting nothing", () => {
    const operations = [
      createReviewerAttemptOperation,
      listReviewerAttemptsOperation,
      getReviewerAttemptOperation,
      resumeReviewerAttemptOperation,
      cancelReviewerAttemptOperation,
    ];
    for (const operation of operations) {
      const parsed = operation.inputSchema.safeParse({
        submission: "sub-1",
        attempt: "att-1",
        passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
        password: PASSWORD,
      });
      expect(parsed.success, operation.name).toBe(false);
      expect(JSON.stringify(parsed.error), operation.name).not.toContain(PASSWORD);
    }
    // A value is not a secret's name.
    const valued = createReviewerAttemptOperation.inputSchema.safeParse({
      submission: "sub-1",
      passwordSecretName: PASSWORD,
    });
    expect(valued.success).toBe(false);
  });

  it("list, read, resume and cancel the submission's attempts by id", async () => {
    const { client, requests } = clientWith({
      [`GET ${BASE}`]: { items: [ATTEMPT] },
      [`GET ${BASE}/att-1`]: ATTEMPT,
      [`POST ${BASE}/att-1/resume`]: { attempt: ATTEMPT, run: RUN },
      [`POST ${BASE}/att-1/cancel`]: { ...ATTEMPT, state: "cancelled" },
    });
    const scope = { submission: "sub-1" };
    const listed = await listReviewerAttemptsOperation.execute({ ...scope, limit: 5 }, { client });
    const read = await getReviewerAttemptOperation.execute({ ...scope, attempt: "att-1" }, { client });
    const resumed = await resumeReviewerAttemptOperation.execute({ ...scope, attempt: "att-1" }, { client });
    const cancelled = await cancelReviewerAttemptOperation.execute({ ...scope, attempt: "att-1" }, { client });

    expect(requests.map((request) => request.key)).toEqual([
      `GET ${BASE}`,
      `GET ${BASE}/att-1`,
      `POST ${BASE}/att-1/resume`,
      `POST ${BASE}/att-1/cancel`,
    ]);
    expect(requests[0]!.query).toEqual({ limit: "5" });
    expect(listed).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", attempts: [ATTEMPT] });
    expect(read.attempt).toEqual(ATTEMPT);
    expect(resumed).toMatchObject({ attempt: ATTEMPT, run: RUN });
    expect(cancelled.attempt.state).toBe("cancelled");
  });

  it("tell an agent the password is saved as a secret first, by name only", () => {
    expect(createReviewerAttemptOperation.description).toMatch(/write-only/);
    expect(createReviewerAttemptOperation.description).toMatch(/MCPJAM_REVIEWER_/);
    expect(cancelReviewerAttemptOperation.readOnly).toBe(false);
  });
});
