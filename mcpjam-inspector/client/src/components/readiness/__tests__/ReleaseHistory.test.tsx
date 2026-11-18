import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  SubmissionEvent,
  SubmissionSummary,
} from "@/lib/apis/directory-submissions-api";
import { ReleaseHistory } from "../ReleaseHistory";
import {
  publicationBadge,
  publishedReleases,
} from "../marketplace-publication";

const api = vi.hoisted(() => ({
  listSubmissionEvents: vi.fn(),
  recordSubmissionEvent: vi.fn(),
  listServerRevisions: vi.fn(),
  diffServerRevisions: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);
vi.mock("@/lib/apis/directory-readiness-api", () => ({
  readinessPlatformClient: () => api,
}));
const submission: SubmissionSummary = {
  id: "sub",
  projectId: "prj",
  serverId: "srv",
  directory: "claude",
  flowId: "claude-connector",
  flowVersion: "1",
  createdBy: "person",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};
function release(version: number): SubmissionEvent {
  return {
    id: String(version),
    projectId: "prj",
    submissionId: "sub",
    actor: "person",
    createdAt: version * 1000,
    reportedOrObserved: "observed",
    kind: "snapshot",
    detail: `Listing description ${version}`,
    snapshot: {
      label: "published",
      serverId: "srv",
      revisionNumber: version,
      note: `Version ${version}`,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listSubmissionEvents.mockImplementation(async (_, kind) =>
    kind === "snapshot" ? [release(1), release(2)] : [],
  );
  api.listServerRevisions.mockResolvedValue({
    items: [{ revisionNumber: 3, counts: { tools: 1 }, capturedAt: 3000 }],
  });
  api.diffServerRevisions.mockResolvedValue({
    tools: { added: [{ name: "new_tool" }], removed: [], changed: [] },
    discovery: [],
    droppedFields: { from: [], to: [] },
  });
});

it("compares the latest recorded release with a capture and two published releases with each other", async () => {
  render(<ReleaseHistory projectId="prj" submission={submission} />);
  expect(await screen.findByText("Added · new_tool")).toBeVisible();
  const diff = (from: number, to: number) =>
    expect(api.diffServerRevisions).toHaveBeenLastCalledWith(
      {
        projectId: "prj",
        serverId: "srv",
        fromRevisionNumber: from,
        revisionNumber: to,
      },
      { signal: expect.any(AbortSignal) },
    );
  diff(2, 3);
  await userEvent.selectOptions(screen.getByLabelText("From"), "1");
  await userEvent.selectOptions(screen.getByLabelText("To"), "2");
  diff(1, 2);
  expect(screen.getByText("Before · Listing description 1")).toBeVisible();
  expect(screen.getByText("After · Listing description 2")).toBeVisible();
  expect(publicationBadge([release(2)])).toEqual({
    label: "Published · 2",
    color: "bg-success",
  });
});

it("keeps publication evidence readable when revisions cannot load", async () => {
  api.listServerRevisions.mockRejectedValue(new Error("offline"));
  render(<ReleaseHistory projectId="prj" submission={submission} />);
  expect(await screen.findByText("Listing description 2")).toBeVisible();
  expect(screen.getByText("Could not load server revisions. Try again.")).toBeVisible();
});

it("records explicitly selected version and catalog once across a failed response and retry", async () => {
  api.recordSubmissionEvent
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce(release(3));
  render(<ReleaseHistory projectId="prj" submission={submission} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Record published version" }),
  );
  await userEvent.type(screen.getByLabelText("Published version"), "3.0");
  await userEvent.selectOptions(
    screen.getByLabelText("Published MCP catalog"),
    "3",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save release" }));
  expect(await screen.findByText("Connection lost")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save release" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save release" })).toBeNull(),
  );
  expect(api.recordSubmissionEvent.mock.calls[0]).toEqual(
    api.recordSubmissionEvent.mock.calls[1],
  );
  expect(api.recordSubmissionEvent.mock.calls[1][1]).toMatchObject({
    snapshot: {
      label: "published",
      serverId: "srv",
      revisionNumber: 3,
      note: "Version 3.0",
    },
    idempotencyKey: expect.any(String),
  });
});

it("keeps a backfilled release and an uncertain snapshot out of the current version", () => {
  const newest = {
    ...release(2),
    evidence: { kind: "text" as const, value: "Published on 2026-11-12" },
  };
  const backfill = {
    ...release(1),
    evidence: { kind: "text" as const, value: "Published on 2026-10-05" },
    createdAt: newest.createdAt + 1,
  };
  expect(
    publishedReleases([
      { ...release(3), uncertain: true },
      backfill,
      newest,
    ]).map((e) => e.id),
  ).toEqual(["2", "1"]);
  expect(publicationBadge([backfill, newest]).label).toBe("Published · 2");
});
