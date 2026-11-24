import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/index.js";

const ONE = "/api/v1/projects/project-1/directory-submissions/sub-1";
const SCOPE = { projectId: "project-1", submissionId: "sub-1" };

/** A client that records each request and answers `{}`. */
function recordingClient() {
  const requests: Array<{ key: string; query: Record<string, string>; body: unknown; launcher: string | null }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      key: `${init?.method ?? "GET"} ${url.pathname}`,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      launcher: new Headers(init?.headers).get("x-mcpjam-launcher"),
    });
    return Response.json({});
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
    launcher: { kind: "cli", client: "mcpjam-cli", version: "1.0.0" },
  });
  return { client, requests };
}

describe("directory submission handoff client methods", () => {
  it("call each route with the query or body it takes", async () => {
    const { client, requests } = recordingClient();
    await client.getDirectorySubmissionHandoff(SCOPE);
    await client.listDirectorySubmissionFindings({ ...SCOPE, step: "listing", status: "violated", cursor: "c1", limit: 50 });
    await client.getDirectorySubmissionFinding({ ...SCOPE, checkId: "claude.endpoint.https" });
    await client.exportDirectorySubmission({ ...SCOPE, format: "markdown" });
    await client.listDirectorySubmissionEvents({ ...SCOPE, kind: "status", limit: 5 });
    await client.getDirectorySubmissionSnapshots({ ...SCOPE, compare: ["production", "directory"] });
    expect(requests.map((request) => request.key)).toEqual([
      `GET ${ONE}/handoff`,
      `GET ${ONE}/findings`,
      `GET ${ONE}/findings/claude.endpoint.https`,
      `GET ${ONE}/export`,
      `GET ${ONE}/events`,
      `GET ${ONE}/snapshots`,
    ]);
    expect(requests.map((request) => request.query)).toEqual([
      {},
      { step: "listing", status: "violated", cursor: "c1", limit: "50" },
      {},
      { format: "markdown" },
      { kind: "status", limit: "5" },
      { compare: "production,directory" },
    ]);
  });

  it("records an event with only the fields its strict body takes, labelled with the launcher", async () => {
    const { client, requests } = recordingClient();
    const extra = { projectSecretValue: "never sent" };
    await client.recordDirectorySubmissionEvent({
      ...SCOPE,
      kind: "snapshot",
      reportedOrObserved: "observed",
      snapshot: { label: "production", revisionNumber: 12 },
      idempotencyKey: "k1",
      ...extra,
    });
    expect(requests[0]).toMatchObject({
      key: `POST ${ONE}/events`,
      body: {
        kind: "snapshot",
        reportedOrObserved: "observed",
        snapshot: { label: "production", revisionNumber: 12 },
        idempotencyKey: "k1",
      },
    });
    expect(requests[0]!.body).not.toHaveProperty("projectSecretValue");
    expect(JSON.parse(requests[0]!.launcher ?? "{}")).toMatchObject({ kind: "cli", client: "mcpjam-cli" });
  });
});
