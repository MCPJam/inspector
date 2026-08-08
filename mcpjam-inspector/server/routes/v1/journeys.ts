/**
 * Public v1 journey surface — the API for what the product calls **Swarms**.
 *
 * NAMING. "Swarm" is not a resource noun here. A swarm is a *container* users
 * author in the UI; what actually executes is a JOURNEY (a persona pursuing a
 * goal against one or more environments) and what it produces is a JOURNEY
 * RUN. Those are the nouns the API exposes, so a caller who has never seen
 * the UI can read the routes and know what they do. "Swarms" survives in help
 * text as the product name it is.
 *
 * The naming trap this avoids is real and lives one repo over: `kind:"swarm"`,
 * `swarm_grant`, and `swarmId: v.id('chatboxes')` in the backend all refer to
 * chatbox GUEST EXECUTION — the user-testing product — and have nothing to do
 * with the Swarms product. A public `/swarms` route would have inherited that
 * ambiguity permanently.
 *
 * `swarmRunGroupId` — the id linking sibling runs of one co-launched batch —
 * is exposed as `waveId`, which says what it is rather than what table it came
 * from.
 *
 * These routes are thin proxies over the same Convex `journeys:*` /
 * `journeyRuns:*` functions the hosted UI calls, with the request's Convex
 * bearer, following `./environments.ts`. Reads require project membership,
 * enforced inside Convex.
 *
 * CROSS-PROJECT SCOPING is enforced HERE, not by Convex, and that is the one
 * thing to be careful about when extending this file. `journeyRuns:listJourneyRuns`
 * takes a `journeyRefId` alone and `journeyRuns:getJourneyRun` takes a `runId`
 * alone — both check membership, neither checks that the resource is in the
 * project named in the path. Without the preflights below, `GET
 * /projects/A/journeys/{a-journey-in-B}/runs` would happily serve project B's
 * runs to a caller who is a member of both. Every route here that takes a
 * resource id resolves it and asserts the project matches, then 404s — never
 * 403, so the route is not an existence oracle for a project the caller cannot
 * see.
 *
 * BETA. The whole surface is behind the `sandboxes-enabled` flag, enforced
 * server-side on WRITES (see the backend's `lib/sandboxesGate.ts`). Reads are
 * deliberately ungated: an empty list leaks nothing, and a fail-closed read
 * gate would blank a legitimately flagged user's screen on any PostHog hiccup.
 * These routes are therefore absent from the public OpenAPI spec and excluded
 * from the MCP/agent/workspace catalogs until GA.
 */
import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";

const journeys = new Hono();

/** Default page size for the paginated reads. Matches the Convex UI's. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function createConvexClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

/**
 * Convex membership failures read as prose, not codes. Collapse anything that
 * smells like "you can't see this" into 404 for the same reason the scoping
 * preflights do: a 403 would confirm the resource exists.
 */
function translateReadError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not a member|not found|unauthorized|insufficient/i.test(message)) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Not found");
  }
  return new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, message);
}

/**
 * `paginationOpts` from the public `cursor` + `limit` query params.
 *
 * Convex's cursor is `null` for the first page (not absent, not `""`), and
 * `numItems` is required. The public contract is the one the rest of `/api/v1`
 * uses: pass the previous response's `nextCursor` back as `cursor`.
 */
function paginationOptsFrom(c: {
  req: { query: (k: string) => string | undefined };
}): { cursor: string | null; numItems: number } {
  const cursor = c.req.query("cursor");
  const rawLimit = Number(c.req.query("limit"));
  const numItems =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  return { cursor: cursor && cursor.length > 0 ? cursor : null, numItems };
}

/**
 * Convex `isDone` is authoritative; `continueCursor` is a non-empty string
 * even on the last page, so returning it unconditionally would make a client
 * loop forever fetching empty pages.
 */
function nextCursorFrom(result: {
  isDone: boolean;
  continueCursor: string;
}): string | undefined {
  return result.isDone ? undefined : result.continueCursor || undefined;
}

// ── Convex row shapes (hand-mirrored from convex/journeys.ts + journeyRuns.ts) ──

type JourneyRow = {
  _id: string;
  projectId: string;
  personaRefId: string;
  swarmRefId: string | null;
  name: string;
  goal: string;
  hostIds?: string[];
  serverAttachmentId: string | null;
  environmentIds: string[] | null;
  config: { sessionsPerTarget?: number; maxTurns?: number } | undefined;
  judgeConfig?: unknown;
  rubric?: unknown;
  createdAt: number;
  updatedAt: number;
};

type JourneyRunRow = {
  _id: string;
  projectId: string;
  journeyRefId: string;
  swarmRefId?: string;
  swarmRunGroupId?: string;
  launchKey?: string;
  status: "running" | "completed" | "partial" | "failed" | "rate_limited";
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  hostSummaries?: Array<{
    hostId: string;
    targetId?: string;
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  }>;
  error?: string;
  snapshot?: {
    hosts?: Array<{
      hostId: string;
      hostName?: string;
      targetId?: string;
      modelId?: string;
    }>;
    personaSnapshot?: { personaId?: string; name?: string; role?: string };
    sessionsPerTarget?: number;
    maxTurns?: number;
  };
  attempts?: Array<{
    chatSessionId: string | null;
    hostId: string;
    targetId: string | null;
    sessionIdx: number;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
  lastHeartbeatAt?: number;
  createdAt: number;
};

type JourneySessionRow = {
  id: string;
  chatSessionId: string;
  projectId: string;
  hostId?: string;
  personaRefId?: string;
  journeyRunId?: string;
  journeyRefId?: string;
  status?: string;
  readiness?: unknown;
  goalScore?: unknown;
  startedAt?: number;
  lastActivityAt?: number;
  modelId?: string;
  messageCount?: number;
  firstMessagePreview?: string;
  personaLabel?: string;
  synthetic?: boolean;
};

// ── Public DTOs ─────────────────────────────────────────────────────────────

function toJourneyDto(row: JourneyRow) {
  return {
    id: row._id,
    projectId: row.projectId,
    name: row.name,
    goal: row.goal,
    personaId: row.personaRefId,
    // The swarm CONTAINER this journey was authored under, if any. Exposed as
    // an opaque id, not as a nested resource — see the header on why "swarm"
    // is not a noun in this API.
    swarmId: row.swarmRefId,
    environmentIds: row.environmentIds ?? [],
    ...(row.serverAttachmentId !== null
      ? { serverAttachmentId: row.serverAttachmentId }
      : {}),
    sessionsPerTarget: row.config?.sessionsPerTarget ?? null,
    maxTurns: row.config?.maxTurns ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toJourneyRunDto(row: JourneyRunRow) {
  return {
    id: row._id,
    projectId: row.projectId,
    journeyId: row.journeyRefId,
    // `swarmRunGroupId` upstream. Renamed because the public meaning is "the
    // batch this run was launched with", and every run of a solo relaunch is
    // a wave of one.
    ...(row.swarmRunGroupId !== undefined
      ? { waveId: row.swarmRunGroupId }
      : {}),
    status: row.status,
    // A run that was CANCELED is `failed` with this marker — the backend
    // deliberately did not add a status literal for it (see
    // `journeyRuns.CANCELED_RUN_ERROR`). Surfaced as a first-class boolean so
    // a client does not have to know that, and does not render a deliberate
    // stop as a failure.
    canceled: row.error === "canceled",
    // Likewise for the stale-runner sweep: the run did not fail on its merits,
    // its runner went silent.
    stale: row.error === "stale_runner",
    ...(row.error !== undefined ? { error: row.error } : {}),
    summary: row.summary,
    targets: (row.snapshot?.hosts ?? []).map((h) => ({
      hostId: h.hostId,
      ...(h.hostName !== undefined ? { hostName: h.hostName } : {}),
      ...(h.targetId !== undefined ? { targetId: h.targetId } : {}),
      ...(h.modelId !== undefined ? { modelId: h.modelId } : {}),
    })),
    ...(row.snapshot?.personaSnapshot
      ? {
          persona: {
            personaId: row.snapshot.personaSnapshot.personaId ?? null,
            name: row.snapshot.personaSnapshot.name ?? null,
            role: row.snapshot.personaSnapshot.role ?? null,
          },
        }
      : {}),
    ...(row.attempts
      ? {
          attempts: row.attempts.map((a) => ({
            chatSessionId: a.chatSessionId,
            hostId: a.hostId,
            targetId: a.targetId,
            sessionIndex: a.sessionIdx,
            status: a.status,
            errorCode: a.errorCode,
            errorMessage: a.errorMessage,
          })),
        }
      : {}),
    ...(row.hostSummaries ? { targetSummaries: row.hostSummaries } : {}),
    createdAt: row.createdAt,
    ...(row.lastHeartbeatAt !== undefined
      ? { lastHeartbeatAt: row.lastHeartbeatAt }
      : {}),
  };
}

function toJourneySessionDto(row: JourneySessionRow) {
  return {
    id: row.chatSessionId,
    projectId: row.projectId,
    ...(row.hostId !== undefined ? { hostId: row.hostId } : {}),
    ...(row.journeyRunId !== undefined ? { runId: row.journeyRunId } : {}),
    ...(row.journeyRefId !== undefined ? { journeyId: row.journeyRefId } : {}),
    ...(row.personaRefId !== undefined ? { personaId: row.personaRefId } : {}),
    ...(row.personaLabel !== undefined
      ? { personaLabel: row.personaLabel }
      : {}),
    status: row.status ?? null,
    readiness: row.readiness ?? null,
    goalScore: row.goalScore ?? null,
    messageCount: row.messageCount ?? 0,
    ...(row.firstMessagePreview !== undefined
      ? { preview: row.firstMessagePreview }
      : {}),
    ...(row.modelId !== undefined ? { modelId: row.modelId } : {}),
    startedAt: row.startedAt ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
  };
}

// ── Scoping preflights ──────────────────────────────────────────────────────

/**
 * Assert `journeyId` belongs to `projectId`, and return it.
 *
 * There is no `journeys:getJourney` by id, so this reads the project's list —
 * which is the authoritative, membership-checked answer to "is this journey in
 * this project" and costs one query. A journey in another project (even one
 * the caller can see) is a 404.
 */
async function requireJourneyInProject(
  client: ConvexHttpClient,
  projectId: string,
  journeyId: string
): Promise<JourneyRow> {
  let rows: JourneyRow[] | null;
  try {
    rows = (await client.query(
      "journeys:listJourneysByProject" as never,
      {
        projectId,
      } as never
    )) as JourneyRow[] | null;
  } catch (error) {
    throw translateReadError(error);
  }
  const found = (rows ?? []).find((row) => String(row._id) === journeyId);
  if (!found) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Journey not found");
  }
  return found;
}

/** Assert `runId` belongs to `projectId`, and return it. */
async function requireRunInProject(
  client: ConvexHttpClient,
  projectId: string,
  runId: string
): Promise<JourneyRunRow> {
  let run: JourneyRunRow | null;
  try {
    run = (await client.query(
      "journeyRuns:getJourneyRun" as never,
      {
        runId,
      } as never
    )) as JourneyRunRow | null;
  } catch (error) {
    throw translateReadError(error);
  }
  if (!run || String(run.projectId) !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Journey run not found");
  }
  return run;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/journeys
journeys.get("/projects/:projectId/journeys", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let rows: JourneyRow[] | null;
  try {
    rows = (await client.query(
      "journeys:listJourneysByProject" as never,
      {
        projectId,
      } as never
    )) as JourneyRow[] | null;
  } catch (error) {
    throw translateReadError(error);
  }
  // Archived journeys are filtered backend-side; this list is live ones only.
  return v1PageJson(c, (rows ?? []).map(toJourneyDto));
});

// GET /v1/projects/:projectId/journeys/:journeyId/runs
journeys.get("/projects/:projectId/journeys/:journeyId/runs", async (c) => {
  const projectId = c.req.param("projectId");
  const journeyId = c.req.param("journeyId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  // Preflight, not decoration: `listJourneyRuns` takes a journeyRefId alone
  // and would serve another project's runs to a caller in both.
  await requireJourneyInProject(client, projectId, journeyId);

  let result: {
    page: JourneyRunRow[];
    isDone: boolean;
    continueCursor: string;
  };
  try {
    result = (await client.query(
      "journeyRuns:listJourneyRuns" as never,
      {
        journeyRefId: journeyId,
        paginationOpts: paginationOptsFrom(c),
      } as never
    )) as typeof result;
  } catch (error) {
    throw translateReadError(error);
  }
  return v1PageJson(
    c,
    result.page.map(toJourneyRunDto),
    nextCursorFrom(result)
  );
});

// GET /v1/projects/:projectId/journey-runs/:runId
journeys.get("/projects/:projectId/journey-runs/:runId", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  return v1Resource(
    c,
    toJourneyRunDto(await requireRunInProject(client, projectId, runId))
  );
});

// GET /v1/projects/:projectId/journey-runs/:runId/sessions
journeys.get("/projects/:projectId/journey-runs/:runId/sessions", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  await requireRunInProject(client, projectId, runId);

  let result: {
    page: JourneySessionRow[];
    isDone: boolean;
    continueCursor: string;
  };
  try {
    result = (await client.query(
      "journeyRuns:listSessionsByJourneyRun" as never,
      {
        journeyRunId: runId,
        paginationOpts: paginationOptsFrom(c),
      } as never
    )) as typeof result;
  } catch (error) {
    throw translateReadError(error);
  }
  return v1PageJson(
    c,
    result.page.map(toJourneySessionDto),
    nextCursorFrom(result)
  );
});

export default journeys;
