/**
 * Public `/api/v1` reads and records beside one directory submission: the
 * handoff summary an agent resumes from, the findings page by page, the
 * export pack, the events someone recorded, and the labelled snapshots.
 *
 * Nothing here stores a summary. The handoff and the pack are built by the SDK
 * on every read, from the same placed results the submission view shows.
 * Findings come from the per-check results store, so each one stays
 * retrievable after its run's report is gone, however many there are.
 *
 * An event is what someone saw or relayed, kept verbatim: MCPJam never records
 * a status by itself. Bodies are `strictObject` and have no field for a
 * secret's value, and text holding a credential recognizable by its shape is
 * refused, because every reader would see it and every export would carry it.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import {
  DIRECTORY_SNAPSHOT_LABELS,
  buildDirectoryExport,
  buildDirectoryHandoff,
  directoryFindingPlace,
  renderDirectoryExportMarkdown,
  type DirectoryFlow,
  type DirectorySnapshotLabel,
  type DirectorySubmissionEvent,
  type DirectorySubmissionSnapshots,
} from "@mcpjam/sdk";
import { isCredentialShapedAuthValue } from "@mcpjam/sdk/browser";
import type { PlatformDirectorySubmissionFinding as Finding } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { requireConvexIdShape } from "./convex-id-param.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { fetchConvexV1Read } from "./convex-v1-proxy.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { flowOf, readSubmission, scopeOf } from "./directory-submissions.js";
import { latestResults, placeResults, readRefusal, type RunRow } from "./directory-submission-views.js";
import { actorLabel } from "./directory-submission-writes.js";

const handoff = new Hono();

const SCOPE = "v1.directory-submissions";
const ONE = "/projects/:projectId/directory-submissions/:submissionId";
/** The backend's largest page, for events and for result scans. */
const PAGE = 100;
const EVENT_KINDS = ["status", "snapshot", "directory-finding", "credential", "answer-reset"] as const;
const STATUSES = ["satisfied", "violated", "not-evaluated", "not-applicable", "informational"] as const;

const query = (name: string) => makeFunctionReference<"query">(name);
const fn = {
  results: query("directorySubmissionResults:listDirectorySubmissionResults"),
  result: query("directorySubmissionResults:getDirectorySubmissionResult"),
  events: query("directorySubmissionEvents:listDirectorySubmissionEvents"),
  snapshots: query("directorySubmissionEvents:getDirectorySubmissionSnapshots"),
  record: makeFunctionReference<"mutation">("directorySubmissionEvents:recordDirectorySubmissionEvent"),
  run: query("claudeReadinessRuns:getReadinessRun"),
};

/** A stored result as the backend returns it, with details as JSON text on the one-result read. */
type Stored = Omit<Finding, "step" | "field" | "details"> & { step?: string; field?: string; details?: string };
type Snapshots = { snapshots: DirectorySubmissionSnapshots } | null;

async function read<T>(convex: ConvexHttpClient, ref: FunctionReference<"query">, args: object): Promise<T> {
  try {
    return await convex.query(ref, args);
  } catch (error) {
    throw readRefusal(error, "Directory submission");
  }
}

/** The submission the path names, read under the caller's bearer. */
async function opened(c: Context) {
  const { projectId, submissionId } = scopeOf(c);
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  return { convex, row: await readSubmission(convex, projectId, submissionId) };
}

async function readEvents(convex: ConvexHttpClient, submissionId: string, args: { kind?: string; limit?: number }) {
  return (await read<DirectorySubmissionEvent[] | null>(convex, fn.events, { submissionId, ...args })) ?? [];
}

/** What the summary and the pack are built from. */
async function handoffInput(c: Context) {
  const { convex, row } = await opened(c);
  const flow = flowOf(row);
  const [results, run, events, found] = await Promise.all([
    latestResults(convex, row),
    row.lastRunId ? read<RunRow | null>(convex, fn.run, { runId: row.lastRunId }) : null,
    // By kind, so many events of one kind cannot push another kind's latest off the page.
    Promise.all(
      ["status", "credential", "directory-finding"].map((kind) => readEvents(convex, row.id, { kind, limit: PAGE }))
    ),
    read<Snapshots>(convex, fn.snapshots, { submissionId: row.id }),
  ]);
  return {
    flow,
    submission: row,
    results: placeResults(flow, row, results),
    resultsRunId: results.report && results.run ? results.run.id : null,
    latestRun: run && { id: run.id, status: run.status, resumable: run.status === "pending" && run.resumable === true },
    events: events.flat(),
    snapshots: found?.snapshots ?? {},
  };
}

handoff.get(`${ONE}/handoff`, async (c) => v1Resource(c, buildDirectoryHandoff(await handoffInput(c))));

const exportQuery = z.object({ format: z.enum(["json", "markdown"]).default("json") });

handoff.get(`${ONE}/export`, async (c) => {
  const { format } = parseWithSchema(exportQuery, c.req.query());
  const input = await handoffInput(c);
  const pack = buildDirectoryExport(input);
  const json = format === "json";
  // The file's own bytes, so the page and the CLI save the same file.
  return v1Resource(c, {
    format,
    filename: `${input.flow.id}-${input.submission.id}-r${input.submission.revision}.${json ? "json" : "md"}`,
    mediaType: json ? "application/json" : "text/markdown",
    content: json ? `${JSON.stringify(pack, null, 2)}\n` : renderDirectoryExportMarkdown(pack),
  });
});

const findingsQuery = z.object({
  status: z.enum(STATUSES).optional(),
  step: z.string().max(100).optional(),
  lane: z.string().max(100).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE).default(25),
});

function oneOf(name: string, value: string | undefined, allowed: string[]) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, `${name}: Use one of: ${allowed.join(", ")}.`);
  }
}

/** A result under the step and field the flow shows it at now, by the rule the counts use. */
function placed(flow: DirectoryFlow, { details: _details, step: _step, field: _field, ...result }: Stored): Finding {
  return { ...result, ...directoryFindingPlace(flow, { id: result.checkId, lane: result.lane }) };
}

/** A page's cursor: the backend page it starts in, and how many of that page's matches were sent. */
const cursorOf = (after: string | null, skip: number) => Buffer.from(JSON.stringify([after, skip])).toString("base64url");

function readCursor(cursor: string | undefined): [string | null, number] {
  if (cursor === undefined) return [null, 0];
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    decoded = undefined;
  }
  const [after, skip] = Array.isArray(decoded) ? decoded : [];
  if ((after === null || typeof after === "string") && Number.isInteger(skip) && skip >= 0) return [after, skip];
  throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "cursor: Send the nextCursor of the page before, unchanged.");
}

handoff.get(`${ONE}/findings`, async (c) => {
  const { status, step, lane, cursor, limit } = parseWithSchema(findingsQuery, c.req.query());
  let [after, skip] = readCursor(cursor);
  const { convex, row } = await opened(c);
  const flow = flowOf(row);
  oneOf("step", step, flow.steps.map((entry) => entry.id));
  oneOf("lane", lane, Object.keys(flow.laneSteps));
  const items: Finding[] = [];
  // A step is the flow's placement, not a stored column, so a page is filled
  // here: read a backend page, take its matches from `skip`, move on.
  for (;;) {
    const page = await read<{ page: Stored[]; isDone: boolean; continueCursor: string }>(convex, fn.results, {
      submissionId: row.id,
      ...(status ? { status } : {}),
      ...(lane ? { lane } : {}),
      ...(after ? { cursor: after } : {}),
      limit: PAGE,
    });
    const matching = page.page.map((result) => placed(flow, result)).filter((result) => !step || result.step === step);
    const taken = matching.slice(skip, skip + limit - items.length);
    items.push(...taken);
    skip += taken.length;
    if (skip < matching.length) return v1PageJson(c, items, cursorOf(after, skip));
    if (page.isDone) return v1PageJson(c, items);
    [after, skip] = [page.continueCursor, 0];
    if (items.length === limit) return v1PageJson(c, items, cursorOf(after, skip));
  }
});

handoff.get(`${ONE}/findings/:checkId`, async (c) => {
  const { convex, row } = await opened(c);
  const result = await read<Stored | null>(convex, fn.result, { submissionId: row.id, checkId: c.req.param("checkId") });
  if (!result) {
    const message = "This submission has no result for that check. List its findings to see the checks it has.";
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, message);
  }
  // Stored as JSON text, because raw observations carry keys a stored object may not.
  const details: unknown = result.details === undefined ? undefined : JSON.parse(result.details);
  return v1Resource(c, { ...placed(flowOf(row), result), ...(details === undefined ? {} : { details }) });
});

const eventsQuery = z.object({
  kind: z.enum(EVENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE).optional(),
});

handoff.get(`${ONE}/events`, async (c) => {
  const args = parseWithSchema(eventsQuery, c.req.query());
  const { convex, row } = await opened(c);
  return v1PageJson(c, await readEvents(convex, row.id, args));
});

const text = (max: number) => z.string().max(max);

/** The backend checks which kind takes which field; this refuses what no kind takes. */
const eventBody = z.strictObject({
  kind: z.enum(EVENT_KINDS),
  reportedOrObserved: z.enum(["reported", "observed"]),
  state: text(100).optional(),
  uncertain: z.boolean().optional(),
  directoryLabel: text(200).optional(),
  detail: text(4000).optional(),
  link: text(2048).optional(),
  reference: text(200).optional(),
  evidence: z.strictObject({ kind: z.enum(["url", "text", "run"]), value: text(4000) }).optional(),
  snapshot: z
    .strictObject({
      label: z.enum(DIRECTORY_SNAPSHOT_LABELS),
      serverId: text(100).optional(),
      revisionNumber: z.number().int().min(1).optional(),
      capturedAt: z.number().positive().optional(),
      note: text(4000).optional(),
    })
    .optional(),
  finding: z
    .strictObject({
      directory: z.enum(["claude", "openai"]).optional(),
      text: text(4000),
      severity: text(200).optional(),
      code: text(200).optional(),
      version: text(200).optional(),
      receivedAt: z.number().positive().optional(),
      via: z.enum(["email", "portal", "other"]),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/**
 * Credentials recognizable by shape alone: a Bearer or Basic value, a JWT, a
 * URL with a password in it. A directory's own words never take these shapes.
 * A plain password cannot be told from prose, which is why a credential event
 * records a state and a secret's name, never a value.
 */
function holdsCredential(value: string): boolean {
  for (const [, token] of value.matchAll(/\b(?:bearer|basic)\s+(\S+)/gi)) {
    if (token && isCredentialShapedAuthValue(token)) return true;
  }
  return /\beyJ[\w-]{8,}\.[\w-]{8,}|:\/\/[^\s/@:]+:[^\s/@]+@/.test(value);
}

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(strings)
      : [];

handoff.post(`${ONE}/events`, async (c) => {
  const body = parseWithSchema(eventBody, await readJsonObjectBody(c));
  if (strings(body).some(holdsCredential)) {
    const message =
      "This event holds what looks like a credential. Remove it, and name the project secret that holds it instead.";
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message);
  }
  const { convex, row } = await opened(c);
  const { snapshot, ...event } = body;
  // A snapshot is of the submission's own server unless it names one.
  const serverId = snapshot && (snapshot.serverId ?? row.serverId);
  if (snapshot && !serverId) {
    const message = "snapshot.serverId: This submission has no saved server. Name the server the snapshot was taken of.";
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message);
  }
  const label = actorLabel(c);
  let recorded: DirectorySubmissionEvent & { replayed?: true };
  try {
    recorded = await convex.mutation(fn.record, {
      ...event,
      submissionId: row.id,
      ...(snapshot && serverId
        ? {
            snapshot: {
              ...snapshot,
              serverId: requireConvexIdShape(serverId, "serverId", { scope: SCOPE, notFoundMessage: "Server not found" }),
            },
          }
        : {}),
      // From the verified attribution, never the body: display only.
      ...(label ? { actorLabel: label } : {}),
    });
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Directory submission event" });
  }
  return v1Resource(c, recorded, recorded.replayed ? 200 : 201);
});

const isLabel = (value: string): value is DirectorySnapshotLabel =>
  (DIRECTORY_SNAPSHOT_LABELS as readonly string[]).includes(value);

handoff.get(`${ONE}/snapshots`, async (c) => {
  const pair = c.req.query("compare")?.split(",");
  if (pair && !(pair.length === 2 && pair[0] !== pair[1] && pair.every(isLabel))) {
    const labels = DIRECTORY_SNAPSHOT_LABELS.join(", ");
    const message = `compare: Name two different labels, such as production,directory. Labels: ${labels}.`;
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message);
  }
  const { convex, row } = await opened(c);
  const found = await read<Snapshots>(convex, fn.snapshots, { submissionId: row.id });
  const view = { submissionId: row.id, snapshots: found?.snapshots };
  if (!pair || !found) return v1Resource(c, view);
  const [from, to] = (pair as DirectorySnapshotLabel[]).map((label) => found.snapshots[label]);
  const serverId = from?.snapshot?.serverId;
  if (!from?.revision || !to?.revision || !serverId || serverId !== to.snapshot?.serverId) {
    const message =
      "Comparing needs both snapshots to name a revision of the same server. Record the missing one with its revision, then compare again.";
    throw new WebRouteError(409, ErrorCode.CONFLICT, message);
  }
  const fromRevision = from.revision.revisionNumber;
  const toRevision = to.revision.revisionNumber;
  // The comparison the server revision diff route serves, for these two revisions.
  const diff = await fetchConvexV1Read(c, "/v1/project-server-revision-diff", (target) => {
    target.searchParams.set("projectId", row.projectId);
    target.searchParams.set("serverId", serverId);
    target.searchParams.set("revisionNumber", String(toRevision));
    target.searchParams.set("from", String(fromRevision));
  });
  if (diff.status !== 200) return c.json(diff.body as Record<string, unknown>, diff.status as 200);
  return v1Resource(c, { ...view, comparison: { from: pair[0], to: pair[1], diff: diff.body } });
});

export default handoff;
