/**
 * Resuming a directory submission from its id: the summary, findings, pack
 * and events as an agent reads them, and the three records it can make.
 */

import { describe, expect, it } from "vitest";
import { buildDirectoryHandoff } from "../../src/directory-readiness/handoff.js";
import {
  exportDirectorySubmissionOperation,
  getDirectorySubmissionFindingOperation,
  getDirectorySubmissionHandoffOperation,
  importDirectoryFindingOperation,
  isPlatformApiError,
  listDirectorySubmissionEventsOperation,
  listDirectorySubmissionFindingsOperation,
  recordDirectorySubmissionSnapshotOperation,
  recordDirectorySubmissionStatusOperation,
} from "../../src/platform/index.js";
import { handoffInput } from "../support/directory-handoff.js";
import {
  BASE,
  PROJECT_INFO,
  clientWith,
} from "../support/directory-submission-client.js";

const ONE = `${BASE}/sub-1`;

const FINDING = {
  checkId: "claude.endpoint.https",
  runId: "run-1",
  lane: "directory-policy",
  class: "required",
  status: "violated",
  title: "Serve the endpoint over https",
  step: "connection",
  field: "connection.serverUrl",
  evaluatedAt: 1,
  engineVersion: "1",
  updatedAt: 2,
  hasDetails: true,
};

const EVENT = {
  id: "event-1",
  submissionId: "sub-1",
  projectId: "project-1",
  kind: "status",
  state: "submitted",
  reportedOrObserved: "reported",
  actor: "user-1",
  actorLabel: "Sample Agent",
  createdAt: 10,
};

describe("reading a submission back", () => {
  it("reads the handoff summary in the project the caller names", async () => {
    const handoff = buildDirectoryHandoff(handoffInput());
    const { client, requests } = clientWith({ [`GET ${ONE}/handoff`]: { body: handoff } });
    const scopes: unknown[] = [];
    const result = await getDirectorySubmissionHandoffOperation.execute(
      { project: "project-1", submission: "sub-1" },
      { client, onScopeResolved: (scope) => scopes.push(scope) }
    );
    expect(requests.map((request) => request.key)).toEqual([`GET ${ONE}/handoff`]);
    expect(result).toEqual({ project: PROJECT_INFO, ...handoff });
    expect(result.nextActions[0]).toMatchObject({ operation: "update_directory_submission" });
    expect(scopes).toEqual([{ projectId: "project-1", organizationId: "org-a" }]);
  });

  it("pages through findings with the caller's filters and cursor", async () => {
    const { client, requests } = clientWith({
      [`GET ${ONE}/findings`]: [
        { body: { items: [FINDING], nextCursor: "page-2" } },
        { body: { items: [] } },
      ],
    });
    const first = await listDirectorySubmissionFindingsOperation.execute(
      { submission: "sub-1", status: "violated", step: "connection", lane: "directory-policy", limit: 1 },
      { client }
    );
    expect(requests[0]!.query).toEqual({
      status: "violated",
      step: "connection",
      lane: "directory-policy",
      limit: "1",
    });
    expect(first).toEqual({
      project: PROJECT_INFO,
      submissionId: "sub-1",
      findings: [FINDING],
      nextCursor: "page-2",
    });
    const last = await listDirectorySubmissionFindingsOperation.execute(
      { submission: "sub-1", cursor: first.nextCursor },
      { client }
    );
    expect(requests[1]!.query).toEqual({ cursor: "page-2" });
    expect(last).not.toHaveProperty("nextCursor");
  });

  it("reads one finding with its evidence", async () => {
    const detailed = { ...FINDING, details: { observed: "http://mcp.example.com/mcp" } };
    const { client, requests } = clientWith({
      [`GET ${ONE}/findings/claude.endpoint.https`]: { body: detailed },
    });
    const result = await getDirectorySubmissionFindingOperation.execute(
      { submission: "sub-1", check: "claude.endpoint.https" },
      { client }
    );
    expect(requests).toHaveLength(1);
    expect(result).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", finding: detailed });
  });

  it("hands back the exported file's bytes unchanged", async () => {
    const file = {
      format: "markdown",
      filename: "claude-connector-sub-1-r4.md",
      mediaType: "text/markdown",
      content: "# Claude connector: sub-1\n\n  kept as written\n",
    };
    const { client, requests } = clientWith({ [`GET ${ONE}/export`]: { body: file } });
    const result = await exportDirectorySubmissionOperation.execute(
      { submission: "sub-1", format: "markdown" },
      { client }
    );
    expect(requests[0]!.query).toEqual({ format: "markdown" });
    expect(result).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", ...file });
  });

  it("lists events of one kind", async () => {
    const { client, requests } = clientWith({ [`GET ${ONE}/events`]: { body: { items: [EVENT] } } });
    const result = await listDirectorySubmissionEventsOperation.execute(
      { submission: "sub-1", kind: "status", limit: 5 },
      { client }
    );
    expect(requests[0]!.query).toEqual({ kind: "status", limit: "5" });
    expect(result).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", events: [EVENT] });
  });
});

describe("recording what happened in the directory", () => {
  it("records a status as reported unless the caller saw it", async () => {
    const { client, requests } = clientWith({
      [`POST ${ONE}/events`]: [{ body: EVENT, status: 201 }, { body: EVENT, status: 201 }],
    });
    const result = await recordDirectorySubmissionStatusOperation.execute(
      { submission: "sub-1", state: "submitted", directoryLabel: "Pending review", reference: "REF-1" },
      { client }
    );
    expect(requests[0]!.body).toEqual({
      kind: "status",
      state: "submitted",
      directoryLabel: "Pending review",
      reference: "REF-1",
      reportedOrObserved: "reported",
    });
    expect(result).toEqual({ project: PROJECT_INFO, event: EVENT });
    await recordDirectorySubmissionStatusOperation.execute(
      { submission: "sub-1", state: "in-review", uncertain: true, reportedOrObserved: "observed", idempotencyKey: "k1" },
      { client }
    );
    expect(requests[1]!.body).toEqual({
      kind: "status",
      state: "in-review",
      uncertain: true,
      reportedOrObserved: "observed",
      idempotencyKey: "k1",
    });
  });

  it("records a snapshot of a server named by the caller, or of the submission's own", async () => {
    const { client, requests } = clientWith({
      [`POST ${ONE}/events`]: [{ body: EVENT, status: 201 }, { body: EVENT, status: 201 }],
    });
    await recordDirectorySubmissionSnapshotOperation.execute(
      { submission: "sub-1", label: "production", server: "markets", revisionNumber: 12 },
      { client }
    );
    expect(requests[0]!.body).toEqual({
      kind: "snapshot",
      snapshot: { label: "production", serverId: "server-1", revisionNumber: 12 },
      reportedOrObserved: "reported",
    });
    await recordDirectorySubmissionSnapshotOperation.execute(
      { submission: "sub-1", label: "directory", note: "Claude still lists 64 tools." },
      { client }
    );
    expect(requests[1]!.body).toEqual({
      kind: "snapshot",
      snapshot: { label: "directory", note: "Claude still lists 64 tools." },
      reportedOrObserved: "reported",
    });
  });

  it("imports what the directory said word for word", async () => {
    const said = "  Remove \"MCP\" from the plugin name.\nThen resubmit.  ";
    const { client, requests } = clientWith({
      [`POST ${ONE}/events`]: { body: { ...EVENT, kind: "directory-finding" }, status: 201 },
    });
    await importDirectoryFindingOperation.execute(
      { submission: "sub-1", text: said, via: "email", version: "1.2.0", receivedAt: 5 },
      { client }
    );
    expect(requests[0]!.body).toEqual({
      kind: "directory-finding",
      finding: { text: said, via: "email", version: "1.2.0", receivedAt: 5 },
      reportedOrObserved: "reported",
    });
  });

  it("refuses a status, label or empty quote the backend would refuse", () => {
    const status = recordDirectorySubmissionStatusOperation.inputSchema;
    expect(status.safeParse({ submission: "sub-1", state: "done" }).success).toBe(false);
    expect(status.safeParse({ submission: "sub-1", state: "withdrawn" }).success).toBe(true);
    const snapshot = recordDirectorySubmissionSnapshotOperation.inputSchema;
    expect(snapshot.safeParse({ submission: "sub-1", label: "live" }).success).toBe(false);
    const imported = importDirectoryFindingOperation.inputSchema;
    expect(imported.safeParse({ submission: "sub-1", text: "", via: "email" }).success).toBe(false);
  });

  it("surfaces the beta refusal on a record", async () => {
    const { client } = clientWith({
      [`POST ${ONE}/events`]: {
        status: 403,
        body: {
          code: "FORBIDDEN",
          message: "Directory readiness is not available for your organization.",
          details: { code: "FEATURE_UNAVAILABLE", feature: "directory-readiness" },
        },
      },
    });
    const error = await recordDirectorySubmissionStatusOperation
      .execute({ submission: "sub-1", state: "submitted" }, { client })
      .catch((caught: unknown) => caught);
    expect(isPlatformApiError(error) && error.details).toMatchObject({ feature: "directory-readiness" });
  });
});
