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
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { launchJourneyRun } from "../../services/sessionSimulation/launch-journey-run.js";
import { getConvexBearerThunkForRequest } from "../../utils/v1-convex-token.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { callerContextFromHono } from "../web/auth.js";
import { HOSTED_MODE } from "../../config.js";

const journeys = new Hono();

/** Default page size for the paginated reads. Matches the Convex UI's. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Convex read failures for this surface. The classification lives in
 * `convex-read-errors.ts` so the scenario routes cannot drift from it — the
 * decision between "you cannot see this", "your credential is bad" and "we are
 * broken" is not a thing to maintain twice.
 */
function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.journeys" });
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
    /**
     * The `chatSessions` DOCUMENT id — the same value `GET /v1/chat-sessions`
     * calls `id`. A session row carries two identifiers and they are not
     * interchangeable: `chatSessionId` is the runtime's own key for the live
     * conversation, and returning it here would mean two endpoints answering
     * "the id of a chat session" with different strings for the same session.
     * A caller that listed a run's sessions could not then look one of them up.
     */
    id: row.id,
    /**
     * The runtime key, kept but named for what it is. It is what the chat
     * transport and the app's own deep links use, so dropping it would strand
     * anyone who needs to correlate a journey session with a live conversation.
     */
    chatSessionId: row.chatSessionId,
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


/**
 * The launch body, which is entirely OPTIONAL — `POST .../runs` with no body
 * runs the journey as authored, and that is the common case.
 *
 * The idempotency key is deliberately NOT in here: it belongs in the
 * `idempotency-key` header, where the rest of the platform's writes put it, so
 * a retry is a header change rather than a body edit.
 */
const launchBodySchema = z.object({
  /** Opaque id linking the sibling runs of one co-launched batch. */
  waveId: z.string().min(1).max(64).optional(),
  /**
   * Fan the journey out across these project environments instead of its
   * authored targets. Shape-checked here; the backend does the real validation
   * (live, in-project, duplicate-free, capped) inside the launch transaction,
   * because only it can see the project's environments.
   */
  environmentIds: z.array(z.string().min(1)).optional(),
});

/**
 * The body if there is one, `undefined` if there is not.
 *
 * A launch with no options is a bodyless POST, and `c.req.json()` throws on an
 * empty payload — which would turn the simplest possible call into a 400.
 */
async function readOptionalJsonBody(c: {
  req: { text: () => Promise<string> };
}): Promise<unknown> {
  const raw = (await c.req.text()).trim();
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON"
    );
  }
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

// POST /v1/projects/:projectId/journey-runs/:runId/cancel
//
// The only WRITE on this surface today, and deliberately the first: until the
// backend's `cancelJourneyRun` landed there was no way to stop a run at all —
// a launch made by mistake could only be waited out while it spent model
// credits.
//
// NOT behind the beta gate. Cancelling REDUCES exposure and spend, so an org
// that has just lost the `sandboxes-enabled` flag must still be able to stop
// what is already running (see the backend's lib/sandboxesGate.ts).
journeys.post("/projects/:projectId/journey-runs/:runId/cancel", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  // Same preflight as the reads: `cancelJourneyRun` checks membership but not
  // the project in the path, so without this a member of two projects could
  // cancel B's run through A's URL.
  await requireRunInProject(client, projectId, runId);

  let result: {
    runId: string;
    status: JourneyRunRow["status"];
    canceled: true;
    alreadyCanceled: boolean;
    finalized: number;
  };
  try {
    result = (await client.mutation(
      "journeyRuns:cancelJourneyRun" as never,
      {
        journeyRunId: runId,
      } as never
    )) as typeof result;
  } catch (error) {
    // CONFLICT (the run already settled on its own) becomes 409 here rather
    // than being flattened — "you cannot stop something that finished" is a
    // different answer from "that failed", and a script retrying blindly
    // should be able to tell them apart.
    throw translateConvexWriteError(error, { resource: "Journey run" });
  }

  return v1Resource(c, {
    id: result.runId,
    status: result.status,
    canceled: true,
    // True when this call found the run already canceled and did nothing. A
    // retry of a dropped response lands here rather than on a 409.
    alreadyCanceled: result.alreadyCanceled,
    /** Attempts this call moved to terminal. Zero on an idempotent replay. */
    finalized: result.finalized,
  });
});

// POST /v1/projects/:projectId/journeys/:journeyId/runs
//
// Launch a journey. Answers **202** with the run id and returns immediately —
// a fan-out can run for hours, so there is nothing useful to wait for. Poll
// `GET /journey-runs/:runId` or stop it with `POST .../cancel`.
//
// IDEMPOTENT, and it has to be: a launch spends model credits, so a retried
// request that got a dropped response must not run the journey twice. The key
// comes from the `idempotency-key` header — the one the SDK client already
// sends for every write, rather than a second spelling invented here — and is
// otherwise a server-minted UUID. A caller who does NOT send the header
// therefore gets a fresh run every time, which is the honest reading of a
// request that declined to identify itself. Replaying a key returns the
// ORIGINAL run with `deduped: true` and starts no second runner.
//
// BEHIND THE BETA GATE. Launching creates exposure and spend, so the backend
// enforces `sandboxes-enabled` on the create; an unflagged organization gets
// FEATURE_UNAVAILABLE through as a 403 with a real message.
journeys.post("/projects/:projectId/journeys/:journeyId/runs", async (c) => {
  const projectId = c.req.param("projectId");
  const journeyId = c.req.param("journeyId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  // Same scoping preflight as the reads, and it matters MORE here: the launch
  // resolves the project from the journey itself, so without this a member of
  // two projects could launch B's journey through A's URL and be billed under
  // a project the URL never named.
  await requireJourneyInProject(client, projectId, journeyId);

  const body = await readOptionalJsonBody(c);
  const parsed = launchBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Invalid request body"
    );
  }

  let result: { runId: string; deduped?: boolean };
  try {
    result = await launchJourneyRun(
      {
        bearerToken: await getConvexBearerForRequest(c),
        // A THUNK for the detached runner. The launch outlives the delegated
        // JWT that authorized it; see `launch-journey-run.ts`.
        getRunBearer: getConvexBearerThunkForRequest(c),
        // Both read the LIVE request and must be resolved before the 202.
        xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
        callerContext: callerContextFromHono(c),
      },
      {
        projectId,
        journeyRefId: journeyId,
        launchKey:
          c.req.header("idempotency-key")?.trim() || randomUUID(),
        ...(parsed.data.waveId ? { waveId: parsed.data.waveId } : {}),
        ...(parsed.data.environmentIds?.length
          ? { environmentIds: parsed.data.environmentIds }
          : {}),
      }
    );
  } catch (error) {
    // `launchJourneyRun` already throws `WebRouteError` for the caller-facing
    // cases; this catches the Convex-shaped ones underneath — above all the
    // beta gate's FEATURE_UNAVAILABLE, which must not collapse into the
    // generic 404 (that would tell a flagged-off customer their journey does
    // not exist).
    if (error instanceof WebRouteError) throw error;
    throw translateConvexWriteError(error, { resource: "Journey" });
  }

  return v1Resource(
    c,
    {
      id: result.runId,
      journeyId,
      projectId,
      status: "running",
      /**
       * True when an idempotency key replayed onto a run that already exists.
       * The response is otherwise identical, so a caller retrying a dropped
       * request can tell "I launched it" from "it was already going" without
       * a second read.
       */
      deduped: result.deduped === true,
    },
    202
  );
});

export default journeys;
