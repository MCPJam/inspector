/**
 * Public v1 USER TESTING surface — what a published scenario produced, and the
 * controls over who can reach it.
 *
 * NAMING. The public noun is "user testing" and the resource is a "scenario":
 * one project environment, published for people outside the project to talk to
 * through a share link. Internally every one of these is a `scenarios` row and
 * that is not changing — a table rename buys no agent capability and costs a
 * migration. What matters is that a caller who has never seen the codebase can
 * read `/user-testing/scenarios/:id/sessions` and know what it returns.
 *
 * `../scenarios.ts` owns PUBLISHING (create/destroy, keyed by environment).
 * This module owns everything you do with a scenario once it exists, keyed by
 * the scenario itself. The split follows the ids: publishing addresses an
 * environment because the scenario does not exist yet.
 *
 * AUTHORIZATION, and it is not the same as everywhere else on `/v1`:
 *
 *   - Scenario mutations gate on the WORKSPACE role, not the project role.
 *     Usually the same people; not always.
 *   - LEGACY WORKSPACES WITH NO `organizationId` HARD-DENY delegated callers
 *     (`delegatedScopeAllowsLegacyWorkspace` upstream). An `sk_` key cannot
 *     write to one at all, and no amount of role granting changes that. The
 *     backend's 403 copy is forwarded verbatim rather than reworded, because
 *     it is the only place that knows why.
 *   - Only PUBLISHING, GUEST EXECUTION and REBINDING need project ADMIN
 *     upstream (`canManageProjectMembers`). Everything else here — mode
 *     changes, renames, member edits, link rotation — gates at
 *     `requireWorkspaceRole(..., 'guest')`: an ordinary member can do all of
 *     it. For the admin trio, an API key acting as an ordinary member gets a
 *     403, and that is the intended answer.
 *
 * CROSS-PROJECT SCOPING is enforced HERE. Every `scenarios:*` mutation takes a
 * `scenarioId` alone and authorizes against whatever workspace the row turns out
 * to be in — never the project in the path. The preflight below resolves the
 * scenario and asserts the project matches, then 404s, so the surface is never
 * an existence oracle for a project the caller cannot see.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { loadInsightsEnvelope } from "./insights-envelope-load.js";
import { readCapped } from "./blob-read.js";

const userTesting = new Hono();

const BASE = "/projects/:projectId/user-testing/scenarios/:scenarioId";

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.user-testing" });
}

/**
 * For SCOPING PREFLIGHTS only — the reads that decide whether a
 * caller-supplied id is visible to the caller at all (`getScenario`,
 * `getSession`). Their refusal paths are workspace-scoped plain errors that
 * production Convex redacts to "Server Error", so without `redactedIsRefusal`
 * a cross-workspace probe answers 502 — an existence oracle plus a Sentry
 * page — instead of the 404 the preflight exists to guarantee. Reads AFTER a
 * preflight keep using `translateReadError`: at that point a redacted error
 * is a genuine incident.
 */
function translatePreflightReadError(
  error: unknown,
  notFoundMessage: string,
): WebRouteError {
  return translateConvexReadError(error, {
    scope: "v1.user-testing",
    notFoundMessage,
    redactedIsRefusal: true,
  });
}

function translateWriteError(error: unknown): WebRouteError {
  return translateConvexWriteError(error, {
    resource: "Scenario",
    // "requires admin" is actionable and reveals nothing new: Convex already
    // confirmed workspace membership, so the caller can see the scenario.
    adminFailureIsForbidden: true,
  });
}

// ── Convex row shapes (hand-mirrored) ───────────────────────────────────────

/**
 * The `scenarios:getScenario` settings envelope, hand-mirrored down to the
 * fields this module reads. NO `accessVersion`: the envelope
 * (`assembleScenarioSettingsResponse` upstream) does not carry it — the value
 * lives on the `scenarios` row and only the publish/rebind projection
 * (`projectEnvironmentScenario`) returns it. Reintroducing it on the update or
 * rotate responses needs the backend envelope to carry it first.
 */
type ScenarioRow = {
  _id: string;
  projectId?: string;
  workspaceId?: string;
  name?: string;
  description?: string;
  mode?: "project_members" | "invited_only" | "anyone_with_link";
  environmentId?: string;
};

type SessionThreadRow = {
  _id: string;
  chatSessionId: string;
  scenarioId?: string;
  modelId?: string;
  messageCount: number;
  firstMessagePreview: string;
  startedAt: number;
  lastActivityAt: number;
  feedbackRating: number | null;
  feedbackComment: string | null;
  feedbackCount: number;
  toolCallCount?: number;
  authInterrupted?: boolean;
  visitorDisplayName?: string;
  visitorSegment?: string;
  authType?: "signedIn" | "guest";
  visitorRecency?: "new" | "returning";
  deviceKind?: string;
  language?: string;
  themeClusterId?: string;
  themeClusterLabel?: string;
  themeKeywords?: string[];
};

// ── DTOs ────────────────────────────────────────────────────────────────────

function toSessionSummaryDto(row: SessionThreadRow) {
  return {
    /** The `chatSessions` document id — the address for the detail route. */
    id: row._id,
    /** The runtime's own key for the live conversation. Not an address here. */
    chatSessionId: row.chatSessionId,
    messageCount: row.messageCount,
    /**
     * First message only. The transcript is a separate, explicit read: a
     * listing that inlined conversations would page real people's words into
     * every caller that only wanted counts.
     */
    preview: row.firstMessagePreview,
    ...(row.modelId !== undefined ? { modelId: row.modelId } : {}),
    ...(row.toolCallCount !== undefined
      ? { toolCallCount: row.toolCallCount }
      : {}),
    /** The visitor abandoned mid-flow because a server demanded auth. */
    ...(row.authInterrupted !== undefined
      ? { authInterrupted: row.authInterrupted }
      : {}),
    visitor: {
      ...(row.visitorDisplayName !== undefined
        ? { displayName: row.visitorDisplayName }
        : {}),
      ...(row.visitorSegment !== undefined
        ? { segment: row.visitorSegment }
        : {}),
      ...(row.authType !== undefined ? { authType: row.authType } : {}),
      ...(row.visitorRecency !== undefined
        ? { recency: row.visitorRecency }
        : {}),
      ...(row.deviceKind !== undefined ? { deviceKind: row.deviceKind } : {}),
      ...(row.language !== undefined ? { language: row.language } : {}),
    },
    feedback: {
      rating: row.feedbackRating,
      comment: row.feedbackComment,
      count: row.feedbackCount,
    },
    ...(row.themeClusterId !== undefined
      ? {
          theme: {
            id: row.themeClusterId,
            label: row.themeClusterLabel ?? null,
            keywords: row.themeKeywords ?? [],
          },
        }
      : {}),
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
  };
}

// ── Preflight ───────────────────────────────────────────────────────────────

/**
 * Assert `scenarioId` is a scenario in `projectId`, and return it.
 *
 * `scenarios:getScenario` resolves the row and authorizes it; the project
 * comparison is this layer's job, because every downstream mutation takes the
 * scenario id alone. A scenario in another project answers 404 — identical to
 * one that does not exist.
 */
async function requireScenarioInProject(
  client: ConvexHttpClient,
  projectId: string,
  scenarioId: string,
): Promise<ScenarioRow> {
  let row: ScenarioRow | null;
  try {
    row = (await client.query(
      "scenarios:getScenario" as never,
      { scenarioId: scenarioId } as never,
    )) as ScenarioRow | null;
  } catch (error) {
    throw translatePreflightReadError(error, "Scenario not found");
  }
  if (!row || String(row.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Scenario not found");
  }
  return row;
}

async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return parsed.data;
}

/** Shared scaffolding: resolve the bearer, scope the scenario, hand both back. */
async function scopedScenario(c: {
  req: { param: (k: string) => string };
}): Promise<{
  client: ConvexHttpClient;
  projectId: string;
  scenarioId: string;
  scenario: ScenarioRow;
}> {
  const projectId = c.req.param("projectId");
  const scenarioId = c.req.param("scenarioId");
  const client = createConvexClient(
    await getConvexBearerForRequest(c as never),
  );
  const scenario = await requireScenarioInProject(
    client,
    projectId,
    scenarioId,
  );
  return { client, projectId, scenarioId, scenario };
}

// ── Scenario metadata ───────────────────────────────────────────────────────

/**
 * SINGLE-CONCERN ONLY, and the 400 on a mixed body is the whole point.
 *
 * Identity (`name`/`description`) and exposure (`mode`) are two different
 * Convex mutations. A route that accepted both would have to call them in
 * sequence, and a failure between the two leaves the scenario half-updated —
 * on the half that decides who can reach it. Splitting the request means the
 * caller sees which one failed and nothing is ever partially applied.
 *
 * This is the same atomicity the publish route protects by forwarding create-
 * time overrides in one call, arrived at from the other direction: publish can
 * do it in one mutation, so it must; update cannot, so it refuses to pretend.
 */
const updateScenarioSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    mode: z
      .enum(["project_members", "invited_only", "anyone_with_link"])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide a field to update.",
  })
  .refine(
    (value) =>
      value.mode === undefined ||
      (value.name === undefined && value.description === undefined),
    {
      message:
        "Send `mode` on its own: identity and exposure are separate operations upstream, and applying them in sequence could leave the scenario live in a mode you did not ask for.",
    },
  );

// GET /v1/projects/:p/user-testing/scenarios/:id
// Scenario detail, enriched with the common insights envelope: findings
// aggregated over the latest analyzed window of real visitor sessions.
// Project members only — this route is deliberately absent from the guest
// allowlist, and the backend envelope query additionally requires workspace
// MEMBERSHIP, so share-link guests can never reach other visitors' evidence.
userTesting.get(BASE, async (c) => {
  const { client, projectId, scenarioId, scenario } = await scopedScenario(c);

  // The envelope is an ENRICHMENT, not the resource. It is gated on workspace
  // MEMBERSHIP while the preflight above only proved the scenario is visible,
  // so a legitimate lower-privilege viewer can be refused here — and in
  // production that refusal arrives as a redacted "Server Error"
  // indistinguishable from a crash. Failing the route on it would answer 502
  // (plus a Sentry page) to an ordinary permission outcome. Omitting instead
  // makes this route behave exactly like the eval and journey-run details:
  // the resource always returns, `insights` is present when the caller may
  // have it, and absence reads as `not_available`.
  const insights = await loadInsightsEnvelope("v1.user-testing", () =>
    client.query(
      "scenarioWindowInsights:getScenarioInsightsEnvelope" as never,
      { scenarioId: scenarioId } as never,
    ),
  );

  return v1Resource(c, {
    id: scenarioId,
    projectId,
    name: scenario.name ?? null,
    description: scenario.description ?? null,
    mode: scenario.mode ?? null,
    // No `accessVersion`, for the same reason the PATCH response omits it:
    // the settings envelope does not carry it, so it would be null on every
    // response. The publish response in `scenarios.ts` has the real one.
    environmentId: scenario.environmentId
      ? String(scenario.environmentId)
      : null,
    ...(insights ? { insights } : {}),
  });
});

// PATCH /v1/projects/:p/user-testing/scenarios/:id
userTesting.patch(BASE, async (c) => {
  const body = await parseBody(c, updateScenarioSchema);
  const { client, projectId, scenarioId } = await scopedScenario(c);

  try {
    if (body.mode !== undefined) {
      await client.mutation(
        "scenarios:setScenarioMode" as never,
        { scenarioId: scenarioId, mode: body.mode } as never,
      );
    } else {
      await client.mutation(
        "scenarios:updateScenario" as never,
        {
          scenarioId: scenarioId,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        } as never,
      );
    }
  } catch (error) {
    throw translateWriteError(error);
  }

  const updated = await requireScenarioInProject(client, projectId, scenarioId);
  // No `accessVersion` here, deliberately: a mode change does bump it
  // upstream, but the settings envelope this re-read returns does not carry
  // the new value (see `ScenarioRow`), and a field that is null on every
  // response is worse than no field. The publish response
  // (`scenarios.ts`) carries the real one.
  return v1Resource(c, {
    id: scenarioId,
    projectId,
    name: updated.name ?? null,
    description: updated.description ?? null,
    mode: updated.mode ?? null,
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

// GET .../sessions
//
// SUMMARIES, not transcripts. `cursor` is the public spelling of the upstream
// `before` timestamp — opaque to the caller, as everywhere else on `/v1`.
userTesting.get(`${BASE}/sessions`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  const rawLimit = Number(c.req.query("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 200)
      : 50;
  const cursor = c.req.query("cursor");
  const before = cursor ? Number(cursor) : undefined;
  if (cursor !== undefined && !Number.isFinite(before)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "cursor must be a value returned as nextCursor by this endpoint",
    );
  }

  let rows: SessionThreadRow[];
  try {
    rows = ((await client.query(
      "chatSessions:listByScenario" as never,
      {
        scenarioId: scenarioId,
        limit,
        ...(before !== undefined ? { before } : {}),
      } as never,
    )) ?? []) as SessionThreadRow[];
  } catch (error) {
    throw translateReadError(error);
  }

  // The upstream page is newest-first and bounded by `limit`, so a full page
  // means there is probably more. The cursor is the oldest row's activity
  // timestamp — the exact value `before` expects.
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? String(rows[rows.length - 1]?.lastActivityAt)
      : undefined;
  return v1PageJson(c, rows.map(toSessionSummaryDto), nextCursor);
});

/**
 * How many transcript messages one page carries.
 *
 * A real user-testing conversation runs long, and the whole thing in one
 * response is both a large payload and — for an agent — a context flood that
 * crowds out the reason it was reading the session.
 */
const TRANSCRIPT_PAGE_SIZE = 50;
const TRANSCRIPT_MAX_PAGE_SIZE = 200;
const TRANSCRIPT_FETCH_TIMEOUT_MS = 10_000;
/**
 * Ceiling on a transcript we will buffer to serve a page.
 *
 * Above this the session reports `transcriptUnavailable` rather than being
 * pulled into memory — a conversation too large to hold is a capacity fact
 * about us, not a reason to take the process down.
 */
const TRANSCRIPT_MAX_BLOB_BYTES = 8 * 1024 * 1024;

type RawMessage = {
  role?: unknown;
  content?: unknown;
  parts?: unknown;
  createdAt?: unknown;
  toolName?: unknown;
};

/**
 * Flatten a message's content to text.
 *
 * Deliberately LOSSY. A stored message can carry tool payloads, base64 images
 * and provider-specific blobs; this projects the parts that are words and
 * drops the rest rather than passing an unbounded structure through a public
 * API. A caller who needs the raw shape has the app.
 */
function messageText(message: RawMessage): string {
  if (typeof message.content === "string") return message.content;
  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
    ? message.content
    : [];
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

// GET .../sessions/:sessionId
//
// The transcript, PAGED and PROJECTED. Two things this deliberately does not
// do:
//
//   1. It never returns `messagesBlobUrl`. That URL is a direct handle on the
//      stored conversation with no further authorization and no expiry the
//      caller can reason about — handing it out would turn one authorized read
//      into an unbounded, unrevocable one, shareable by anyone who receives it.
//      The gateway fetches the blob itself and serves the contents.
//   2. It does not return raw message objects. Stored messages carry tool
//      payloads and provider blobs; the DTO projects role, text and timing.
userTesting.get(`${BASE}/sessions/:sessionId`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  const sessionId = c.req.param("sessionId");

  const rawLimit = Number(c.req.query("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), TRANSCRIPT_MAX_PAGE_SIZE)
      : TRANSCRIPT_PAGE_SIZE;
  // Validated, not coerced. `Number("oops")` is NaN and silently became page
  // 1 — so a caller paging with a mistyped or stale cursor got already-seen
  // messages back with a fresh `nextCursor` and no signal, and could act on
  // the same conversation twice. The sibling sessions route already 400s here.
  const rawCursor = c.req.query("cursor");
  let offset = 0;
  if (rawCursor !== undefined) {
    const parsedCursor = Number(rawCursor);
    if (!Number.isInteger(parsedCursor) || parsedCursor < 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "cursor must be a value returned as nextCursor by this endpoint",
      );
    }
    offset = parsedCursor;
  }

  let session: (Record<string, unknown> & { messagesBlobUrl?: string }) | null;
  try {
    session = (await client.query(
      "chatSessions:getSession" as never,
      { sessionId } as never,
    )) as typeof session;
  } catch (error) {
    // Preflight semantics: `getSession` refuses with a plain
    // "ChatSession not found or unauthorized" (redacted in production), and
    // the id came from the caller — so refusal and absence must be the same
    // 404 here too.
    throw translatePreflightReadError(error, "Session not found");
  }
  // The scenario preflight proved the caller may see THIS scenario; this
  // proves the session belongs to it. `getSession` authorizes broadly (project
  // members can read swarm sessions), so without the check a project member
  // could read any session in the project through a scenario's URL.
  if (!session || String(session.scenarioId ?? "") !== scenarioId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Session not found");
  }

  let messages: RawMessage[] = [];
  let transcriptUnavailable = false;
  if (typeof session.messagesBlobUrl === "string") {
    try {
      const response = await fetch(session.messagesBlobUrl, {
        signal: AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS),
      });
      // BOUNDED WHILE READING, not from the header. The timeout caps latency,
      // not bytes, and `response.json()` materializes the whole conversation on
      // a request thread — so without a ceiling, memory scales with transcript
      // size times concurrent readers and nothing stops it.
      //
      // `content-length` cannot be that ceiling. It is absent on a chunked
      // response and merely a claim when present, and the absent case is the
      // dangerous one: `Number(null)` is 0, which passes any `> MAX` test and
      // hands an unbounded body to the parser. So the cap is enforced against
      // bytes actually received, and the header is not consulted at all.
      if (!response.ok) {
        transcriptUnavailable = true;
      } else {
        const text = await readCapped(response, TRANSCRIPT_MAX_BLOB_BYTES);
        if (text === null) {
          transcriptUnavailable = true;
        } else {
          const parsed = JSON.parse(text) as unknown;
          const candidate = Array.isArray(parsed)
            ? parsed
            : (parsed as { messages?: unknown })?.messages;
          if (Array.isArray(candidate)) messages = candidate as RawMessage[];
        }
      }
    } catch {
      // A blob we cannot read is reported as such rather than as an empty
      // conversation: "they said nothing" and "we could not fetch it" lead to
      // opposite conclusions about a user test.
      transcriptUnavailable = true;
    }
  } else {
    // `messagesBlobId` is a required field, so a session ALWAYS has a blob —
    // a non-string URL means `ctx.storage.getUrl` returned null because the
    // stored file was deleted. That is "we cannot read it", not "the visitor
    // said nothing": without this branch a deleted blob reported
    // `messageCount: 0`, the exact misreport documented below.
    transcriptUnavailable = true;
  }

  const page = messages.slice(offset, offset + limit);
  return v1Resource(c, {
    id: sessionId,
    scenarioId,
    chatSessionId: session.chatSessionId ?? null,
    modelId: session.modelId ?? null,
    startedAt: session.startedAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
    /**
     * `null` — never 0 — when the transcript could not be read. Zero is a
     * claim that the visitor said nothing, which is the opposite of what an
     * unreadable blob means, and a consumer reading only this field would act
     * on it.
     */
    messageCount: transcriptUnavailable ? null : messages.length,
    /**
     * True when the stored conversation could not be read. Distinct from an
     * empty `messages` array, which means the visitor genuinely said nothing.
     */
    ...(transcriptUnavailable ? { transcriptUnavailable: true } : {}),
    messages: page.map((message) => ({
      role: typeof message.role === "string" ? message.role : "unknown",
      text: messageText(message),
      ...(typeof message.toolName === "string"
        ? { toolName: message.toolName }
        : {}),
      ...(typeof message.createdAt === "number"
        ? { createdAt: message.createdAt }
        : {}),
    })),
    ...(offset + page.length < messages.length
      ? { nextCursor: String(offset + page.length) }
      : {}),
  });
});

// GET .../metrics
userTesting.get(`${BASE}/metrics`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  const population = c.req.query("population");
  // Validated HERE, not left to Convex: the upstream union validator rejects
  // an unknown value with an ArgumentValidationError, which reads as 404 —
  // but a bad query-parameter value is the caller's input, and 400 with the
  // accepted values is the answer they can act on.
  if (population !== undefined && !["real", "synthetic"].includes(population)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'population must be "real" or "synthetic"',
    );
  }
  let metrics: unknown;
  try {
    metrics = await client.query(
      "chatSessions:getScenarioSessionMetrics" as never,
      {
        scenarioId: scenarioId,
        ...(population ? { population } : {}),
      } as never,
    );
  } catch (error) {
    throw translateReadError(error);
  }
  if (metrics === null || metrics === undefined) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "This scenario has no session metrics yet",
    );
  }
  return v1Resource(c, metrics);
});

// GET .../usage
//
// Carries the upstream `truncated` flag through UNTOUCHED. It means the rates
// above it were computed over the most recent N sessions rather than all of
// them, and a consumer that drops it turns a conditional statistic into an
// unconditional one.
userTesting.get(`${BASE}/usage`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  let usage: unknown;
  try {
    usage = await client.query(
      "chatSessions:getUsageBreakdown" as never,
      { scenarioId: scenarioId } as never,
    );
  } catch (error) {
    throw translateReadError(error);
  }
  if (usage === null || usage === undefined) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "This scenario has no usage data yet",
    );
  }
  return v1Resource(c, usage);
});

// ── Insights ────────────────────────────────────────────────────────────────

// GET .../findings
userTesting.get(`${BASE}/findings`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  let rows: unknown[];
  try {
    rows = ((await client.query(
      "scenarioWindowInsights:listScenarioFindings" as never,
      { scenarioId: scenarioId } as never,
    )) ?? []) as unknown[];
  } catch (error) {
    throw translateReadError(error);
  }
  return v1PageJson(c, rows);
});

// GET .../signals
//
// Also how you learn the CURRENT window id, which the window-insights read
// below takes. There is no separate "list windows" route because the only
// window anyone asks about is the live one.
userTesting.get(`${BASE}/signals`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  let signals: unknown;
  try {
    signals = await client.query(
      "scenarioWindowInsights:getWindowSignals" as never,
      { scenarioId: scenarioId } as never,
    );
  } catch (error) {
    throw translateReadError(error);
  }
  if (signals === null || signals === undefined) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "This scenario has no analyzed window yet",
    );
  }
  return v1Resource(c, signals);
});

// GET .../windows/:windowId/insights
userTesting.get(`${BASE}/windows/:windowId/insights`, async (c) => {
  const { client, scenarioId } = await scopedScenario(c);
  const windowId = c.req.param("windowId");
  let insights: unknown;
  try {
    insights = await client.query(
      "scenarioWindowInsights:getWindowInsights" as never,
      { scenarioId: scenarioId, windowGroupId: windowId } as never,
    );
  } catch (error) {
    throw translateReadError(error);
  }
  if (insights === null || insights === undefined) {
    // Never requested. Distinct from `pending`, so a caller polling in a loop
    // does not mistake "nobody asked" for "asked and still working".
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "No insights have been requested for this window",
    );
  }
  return v1Resource(c, { windowId, ...(insights as object) });
});

const requestInsightsSchema = z
  .strictObject({ force: z.boolean().optional() })
  .optional();

// POST .../insights
//
// 202 with the window id the request applies to. SPENDS against the org's
// `insightsPerDay` ledger, which is SHARED with swarm wave insights.
userTesting.post(`${BASE}/insights`, async (c) => {
  const raw = (await c.req.text()).trim();
  let body: { force?: boolean } | undefined;
  if (raw.length > 0) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be JSON",
      );
    }
    const parsed = requestInsightsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues[0]?.message ?? "Invalid request body",
      );
    }
    body = parsed.data;
  }

  const { client, projectId, scenarioId } = await scopedScenario(c);
  let result: { windowGroupId: string };
  try {
    result = (await client.mutation(
      "scenarioWindowInsights:requestWindowInsights" as never,
      {
        scenarioId: scenarioId,
        ...(body?.force ? { force: true } : {}),
      } as never,
    )) as { windowGroupId: string };
  } catch (error) {
    // `window_not_analyzed` is a 409 with real copy rather than a bare
    // validation error: the request was well-formed and retrying it verbatim
    // will not help until the window has been mined.
    const message = error instanceof Error ? error.message : String(error);
    if (/window_not_analyzed/.test(message)) {
      throw new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        "This scenario's current window has not been analyzed yet, so there is nothing to generate insights over. Wait for sessions to be processed and try again.",
      );
    }
    throw translateWriteError(error);
  }

  return v1Resource(
    c,
    {
      scenarioId,
      projectId,
      windowId: result.windowGroupId,
      status: "pending",
    },
    202,
  );
});

const cancelInsightsSchema = z.strictObject({
  windowId: z.string().trim().min(1),
});

// DELETE .../insights
//
// Takes the window id in the body because cancellation is scoped to one
// generation, and the recovery case this exists for — a window stuck pending —
// is precisely when you have the id and nothing else works.
userTesting.delete(`${BASE}/insights`, async (c) => {
  const body = await parseBody(c, cancelInsightsSchema);
  const { client, projectId, scenarioId } = await scopedScenario(c);
  try {
    await client.mutation(
      "scenarioWindowInsights:cancelWindowInsights" as never,
      { scenarioId: scenarioId, windowGroupId: body.windowId } as never,
    );
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, {
    scenarioId,
    projectId,
    windowId: body.windowId,
    canceled: true,
  });
});

// POST .../findings/:findingId/dismiss  |  /undismiss
//
// The same `swarmFindings` mutations the swarm surface uses: they are
// scope-branched upstream, authorizing a scenario finding by its workspace role
// and a project finding by its project role. Nothing here needs to know which.
for (const action of ["dismiss", "undismiss"] as const) {
  userTesting.post(`${BASE}/findings/:findingId/${action}`, async (c) => {
    const { client, projectId, scenarioId } = await scopedScenario(c);
    const findingId = c.req.param("findingId");
    // The finding must belong to THIS scenario, or a member of two scenarios
    // could dismiss the other's finding through this URL.
    // `_id`, NOT `findingId`. The swarm findings DTO names the same column
    // `findingId` and this one does not, so matching on the swarm spelling
    // made every scenario dismissal 404 — the scope check could never pass.
    let findings: Array<{ _id?: string }>;
    try {
      findings = ((await client.query(
        "scenarioWindowInsights:listScenarioFindings" as never,
        { scenarioId: scenarioId } as never,
      )) ?? []) as Array<{ _id?: string }>;
    } catch (error) {
      throw translateReadError(error);
    }
    if (!findings.some((row) => String(row._id) === findingId)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Finding not found");
    }

    try {
      await client.mutation(
        `swarmWaveInsights:${action}Finding` as never,
        { findingId } as never,
      );
    } catch (error) {
      throw translateWriteError(error);
    }
    return v1Resource(c, {
      id: findingId,
      scenarioId,
      projectId,
      dismissed: action === "dismiss",
    });
  });
}

// ── Exposure controls ───────────────────────────────────────────────────────
//
// Everything below changes WHO CAN REACH the scenario or WHAT IT MAY SPEND on
// their behalf — but the upstream gates differ, and the difference matters:
// guest execution and rebinding need project admin
// (`canManageProjectMembers`), while link rotation and member edits gate at
// workspace membership (`requireWorkspaceRole(..., 'guest')`) like the mode
// change above — an ordinary member can do them. For the admin-gated pair, an
// API key acting as an ordinary member gets a 403, which is the intended
// answer.

const guestExecutionSchema = z.strictObject({
  enabled: z.boolean(),
  computerEnabled: z.boolean(),
  sharedSkillsEnabled: z.boolean(),
  /** Hard ceiling on what visitors can spend per day, in credits. */
  dailyCreditCap: z.number().min(0),
  dailyComputerStartCap: z.number().int().min(0),
  maxConcurrentComputers: z.number().int().min(0),
  harnessEnabled: z.boolean().optional(),
  dailyHarnessSpendCapMicros: z.number().int().min(0).optional(),
  dailyHarnessCallCap: z.number().int().min(0).optional(),
  maxConcurrentHarnessRuns: z.number().int().min(0).optional(),
});

// PUT .../guest-execution
//
// The spend dial for anonymous visitors. A full replacement rather than a
// patch, deliberately: these caps only mean something as a SET, and a partial
// update that raised `dailyCreditCap` while leaving a stale
// `maxConcurrentComputers` behind would produce a combination nobody chose.
userTesting.put(`${BASE}/guest-execution`, async (c) => {
  const body = await parseBody(c, guestExecutionSchema);
  const { client, projectId, scenarioId } = await scopedScenario(c);
  try {
    await client.mutation(
      "scenarios:setScenarioGuestExecution" as never,
      { scenarioId: scenarioId, guestExecution: body } as never,
    );
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, { id: scenarioId, projectId, guestExecution: body });
});

// POST .../rotate-link
//
// Mints a new link token; the old URL stops resolving at once, and a caller
// cannot undo this by rotating back.
//
// It does NOT evict anyone who already redeemed the old link. `scenarioAccess`
// rows are the authoritative grant store and rotation does not touch them —
// `rotateScenarioLink` patches the token and deliberately leaves
// `accessVersion` alone (see `lib/scenarioAccessLifecycle.ts`, invariant 2).
// So this closes the door without removing anyone already inside: for a leak,
// rotate AND remove the members who should not be there.
userTesting.post(`${BASE}/rotate-link`, async (c) => {
  const { client, projectId, scenarioId } = await scopedScenario(c);
  let result: { link?: unknown } | null;
  try {
    result = (await client.mutation(
      "scenarios:rotateScenarioLink" as never,
      { scenarioId: scenarioId } as never,
    )) as { link?: unknown } | null;
  } catch (error) {
    throw translateWriteError(error);
  }
  // PROJECTED, not spread. Spreading an unread mutation result makes every
  // field upstream adds part of the public contract without review — and on
  // THIS route the fields in question are share secrets.
  //
  // No `accessVersion`: the mutation returns the settings envelope, which
  // does not carry it (see `ScenarioRow`) — the value only travels on the
  // publish/rebind projection. Reporting `null` forever documented a
  // revocation signal this response never actually delivered.
  return v1Resource(c, {
    id: scenarioId,
    projectId,
    rotated: true,
    link: result?.link ?? null,
  });
});

const upsertMemberSchema = z.strictObject({
  email: z.string().trim().min(3).max(320),
  /** Off by default: adding someone quietly is not the same as inviting them. */
  sendInviteEmail: z.boolean().optional(),
});

// PUT .../members — upsert by email, so a re-invite is not an error.
userTesting.put(`${BASE}/members`, async (c) => {
  const body = await parseBody(c, upsertMemberSchema);
  const { client, projectId, scenarioId } = await scopedScenario(c);
  let result: { memberId?: string; invited?: boolean } | null;
  try {
    result = (await client.mutation(
      "scenarios:upsertScenarioMember" as never,
      {
        scenarioId: scenarioId,
        email: body.email,
        // ALWAYS forwarded, never omitted: the backend defaults an absent
        // `sendInviteEmail` to TRUE and mails the person a working share
        // link. This route documents quiet-add as the default, so absence
        // must be an explicit `false` — omitting the field here silently
        // inverts the contract on an exposure-granting write.
        sendInviteEmail: body.sendInviteEmail ?? false,
      } as never,
    )) as { memberId?: string; invited?: boolean } | null;
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, {
    scenarioId,
    projectId,
    email: body.email,
    ...(result?.memberId !== undefined ? { memberId: result.memberId } : {}),
    ...(result?.invited !== undefined ? { invited: result.invited } : {}),
  });
});

// DELETE .../members/:memberIdOrEmail
//
// Removing a member NARROWS access, which is why it is not behind the beta
// gate: an org that has just lost the flag must still be able to revoke.
userTesting.delete(`${BASE}/members/:memberIdOrEmail`, async (c) => {
  const { client, projectId, scenarioId } = await scopedScenario(c);
  const memberIdOrEmail = c.req.param("memberIdOrEmail");
  try {
    await client.mutation(
      "scenarios:removeScenarioMember" as never,
      { scenarioId: scenarioId, memberIdOrEmail } as never,
    );
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, { scenarioId, projectId, removed: memberIdOrEmail });
});

const rebindSchema = z.strictObject({
  environmentId: z.string().trim().min(1),
});

// POST .../rebind
//
// Point an existing scenario at a DIFFERENT environment, keeping its link,
// its members and its session history. The alternative — unpublish and
// republish — mints a new link, which means re-sharing it with everyone.
//
// The new environment is checked against THIS project first: the Convex
// mutation resolves the environment on its own, so without the preflight a
// member of two projects could rebind a scenario onto another project's
// environment and expose it under this project's link.
userTesting.post(`${BASE}/rebind`, async (c) => {
  const body = await parseBody(c, rebindSchema);
  const { client, projectId, scenarioId } = await scopedScenario(c);

  let environment: unknown;
  try {
    environment = await client.query(
      "projectEnvironments:getEnvironment" as never,
      { projectId, environmentId: body.environmentId } as never,
    );
  } catch (error) {
    throw translateReadError(error);
  }
  if (!environment) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Environment not found");
  }

  let result: { accessVersion?: number } | null;
  try {
    result = (await client.mutation(
      "scenarios:rebindEnvironmentScenario" as never,
      { scenarioId: scenarioId, environmentId: body.environmentId } as never,
    )) as { accessVersion?: number } | null;
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, {
    id: scenarioId,
    projectId,
    environmentId: body.environmentId,
    accessVersion: result?.accessVersion ?? null,
  });
});

export default userTesting;
