import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  PlatformApiError,
  directorySubmissionConflict,
} from "../../src/platform/index.js";

const BASE = "/api/v1/projects/project-1/directory-submissions";

/** A client that records each request and answers `{}`. */
function recordingClient() {
  const requests: Array<{
    key: string;
    query: Record<string, string>;
    body: unknown;
    launcher: string | null;
  }> = [];
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

const SCOPE = { projectId: "project-1", submissionId: "sub-1" };

describe("directory submission client methods", () => {
  it("call each route with only the fields its strict body takes", async () => {
    const { client, requests } = recordingClient();
    await client.listDirectoryFlows();
    await client.getDirectoryFlow({ flowId: "claude-connector" });
    await client.createDirectorySubmission({
      projectId: "project-1",
      flowId: "claude-connector",
      serverId: "server-1",
      idempotencyKey: "c1",
    });
    await client.listDirectorySubmissions({
      projectId: "project-1",
      serverId: "server-1",
      limit: 5,
    });
    await client.getDirectorySubmission(SCOPE);
    await client.updateDirectorySubmission({
      ...SCOPE,
      expectedRevision: 3,
      answers: { "listing.name": "Acme", "listing.retired": null },
      confirm: ["useCases.access"],
      checkGate: { warnOnly: ["claude.submission.listing-fields"] },
    });
    await client.deleteDirectorySubmission(SCOPE);
    await client.startDirectorySubmissionRun({
      ...SCOPE,
      includeLlmObservations: true,
    });
    await client.getDirectorySubmissionResults({ ...SCOPE, runId: "run-1" });

    expect(requests.map((request) => request.key)).toEqual([
      "GET /api/v1/directory-flows",
      "GET /api/v1/directory-flows/claude-connector",
      `POST ${BASE}`,
      `GET ${BASE}`,
      `GET ${BASE}/sub-1`,
      `PATCH ${BASE}/sub-1`,
      `DELETE ${BASE}/sub-1`,
      `POST ${BASE}/sub-1/runs`,
      `GET ${BASE}/sub-1/results`,
    ]);
    expect(requests[2]!.body).toEqual({
      flowId: "claude-connector",
      serverId: "server-1",
      idempotencyKey: "c1",
    });
    expect(requests[3]!.query).toEqual({ serverId: "server-1", limit: "5" });
    expect(requests[5]!.body).toEqual({
      expectedRevision: 3,
      answers: { "listing.name": "Acme", "listing.retired": null },
      confirm: ["useCases.access"],
      checkGate: { warnOnly: ["claude.submission.listing-fields"] },
    });
    expect(requests[7]!.body).toEqual({ includeLlmObservations: true });
    expect(requests[8]!.query).toEqual({ runId: "run-1" });
  });

  it("declares the launcher on answer writes only, which labels an agent's answers", async () => {
    const { client, requests } = recordingClient();
    await client.getDirectorySubmission(SCOPE);
    await client.updateDirectorySubmission({ ...SCOPE, expectedRevision: 1, title: "Draft" });
    expect(requests[0]!.launcher).toBeNull();
    expect(JSON.parse(requests[1]!.launcher ?? "{}")).toMatchObject({
      kind: "cli",
      client: "mcpjam-cli",
    });
  });
});

describe("directorySubmissionConflict", () => {
  it("reads a conflict's details and ignores every other error", () => {
    const conflict = new PlatformApiError("changed", "CONFLICT", {
      status: 409,
      details: {
        currentRevision: 5,
        conflictingKeys: ["listing.name", 7],
        current: { id: "sub-1", revision: 5 },
      },
    });
    expect(directorySubmissionConflict(conflict)).toEqual({
      currentRevision: 5,
      conflictingKeys: ["listing.name"],
      current: { id: "sub-1", revision: 5 },
    });
    const other = new PlatformApiError("gone", "NOT_FOUND", { status: 404 });
    expect(directorySubmissionConflict(other)).toBeUndefined();
    expect(directorySubmissionConflict(new Error("x"))).toBeUndefined();
  });
});
