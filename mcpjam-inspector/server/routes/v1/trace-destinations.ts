/**
 * Public v1 TRACE DESTINATIONS surface — where an organization's traces are
 * STREAMED.
 *
 * Before this, tracing was pull-only: a caller exported OTLP from a run on
 * demand, or polled `GET /v1/trace-exports/otlp`. A destination inverts that —
 * MCPJam pushes every eligible turn to the vendor's OTLP/HTTP intake within
 * about a minute, continuously, with no export step for anyone to forget.
 *
 * ## Header values are write-only, without exception
 *
 * A destination authenticates with vendor headers — a Coralogix Send-Your-Data
 * key, a Honeycomb team token, a Grafana basic credential. Those values cross
 * exactly one boundary: this request, and then the Convex Node action that
 * encrypts them into the secret store. No route here returns one, and none can:
 * the Convex view type carries `headerNames` and has no field a value could
 * live in. A test asserts that on the RESPONSE SCHEMA rather than on a sample
 * body, because a sample body only proves what one fixture happened not to
 * contain.
 *
 * `headers` on a PATCH REPLACES the whole set, and its absence leaves the
 * stored set alone. There is no way to edit one header in place, and that is
 * deliberate: a partial update would have to read the stored values to merge
 * them, and nothing in this system is allowed to read them but the sender.
 *
 * ## Writes go through Convex ACTIONS, so a DTO needs a second read
 *
 * `createDestination` returns an id and `updateDestination` returns nothing,
 * because both are actions whose real work is in the secret store. Each write
 * route below therefore re-reads the row to answer with the same DTO every
 * read produces. The alternative — inventing a response from the request body
 * — would report what the caller asked for rather than what was stored, which
 * differs whenever the backend normalizes (a URL that gains `/v1/traces`, a
 * `sourceTypes` list that gets de-duplicated).
 *
 * ## Authorization and org scoping are enforced in CONVEX, not here
 *
 * Every function behind these routes runs `requireOrgRole` — member to read,
 * admin to write — and a delegated organization key (`sk_`) is clamped to its
 * own organization inside `getOrgMembership`. So a route that named another
 * org's id would be refused by the same code path the UI uses, and there is no
 * copy of the rule in this file to drift from it.
 *
 * ## Not in the public spec yet
 *
 * These routes are listed in the Inspector's `KNOWN_UNDOCUMENTED` baseline and
 * are deliberately absent from `reference/openapi.json`: availability is
 * decided per organization, and `docs/README.md` is explicit that such a
 * feature is not documented until the flag comes off. The SDK and CLI carry
 * them regardless — a caller who has been flagged in needs a client.
 *
 * ## Guests
 *
 * `guest-allowed-paths.ts` is default-deny and there is deliberately NO entry
 * for `/trace-destinations`. Nothing here is reachable by an unauthenticated
 * caller, and adding an entry would be the single change that breaks that.
 */
import { Hono } from "hono";
import { z } from "zod";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const traceDestinations = new Hono();

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.traceDestinations" });
}

/**
 * Convex `traceDestinations:TraceDestinationView`, hand-mirrored.
 *
 * Note what is NOT here and could not be added by accident: a header value.
 * The backend view type has no such field, so adding one to this type would
 * fail to compile against nothing — which is why the contract test asserts on
 * the response schema instead of trusting the mirror.
 */
type TraceDestinationRow = {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  endpointUrl: string;
  headerNames: string[];
  resourceAttributes: Record<string, string>;
  sourceTypes: string[];
  includeContent: boolean;
  compression: "gzip" | "none";
  projectIds: string[] | null;
  preset: string | null;
  paused: { at: number; reason: string } | null;
  health: {
    lastAttemptAt: number | null;
    lastDeliveryAt: number | null;
    lastDeliveryStatus: string | null;
    lastDeliveryError: string | null;
    lastHttpStatus: number | null;
    consecutiveFailures: number;
    retryNotBefore: number | null;
    pendingCount: number;
    pendingCountCapped: boolean;
    deliveredSessionCount: number;
    deliveredSpanCount: number;
    deadLetterCount: number;
  } | null;
  lastTest: { at: number; status: string; error: string | null } | null;
  createdAt: number;
  updatedAt: number;
};

type BackfillJobRow = {
  _id: string;
  destinationId: string;
  organizationId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  sinceMs: number;
  scanned: number;
  enqueued: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
};

function toTraceDestinationDto(row: TraceDestinationRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    enabled: row.enabled,
    /** Normalized server-side: HTTPS, and ending in `/v1/traces`. */
    endpointUrl: row.endpointUrl,
    /** NAMES ONLY. The values are write-only; see the module header. */
    headerNames: row.headerNames,
    resourceAttributes: row.resourceAttributes,
    sourceTypes: row.sourceTypes,
    includeContent: row.includeContent,
    compression: row.compression,
    /** `null` means every project in the organization, present and future. */
    projectIds: row.projectIds,
    preset: row.preset,
    /**
     * Non-null means nothing is being queued. `reason` is a machine name
     * (`manual`, `auth_failed`, `secret_unreadable`, `redirect_required`,
     * `permanent_failures`) so a client can map it to its own copy.
     */
    paused: row.paused,
    health: row.health,
    lastTest: row.lastTest,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBackfillJobDto(row: BackfillJobRow) {
  return {
    id: row._id,
    destinationId: row.destinationId,
    organizationId: row.organizationId,
    status: row.status,
    /** The instant the window starts. Sessions active since then are queued. */
    since: row.sinceMs,
    sessionsScanned: row.scanned,
    sessionsQueued: row.enqueued,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt ?? null,
  };
}

const headerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/,
    "Header names must be HTTP tokens: letters, digits and !#$%&'*+.^_`|~- only.",
  );

/**
 * A header value.
 *
 * NOT trimmed, deliberately, and the schema must not add `.trim()`: whitespace
 * can be meaningful inside a credential, and silently rewriting what the caller
 * sent produces a failure that presents as "the API key is wrong" with nothing
 * to look at.
 */
const headerValueSchema = z.string().min(1).max(4096);

const headersSchema = z.record(headerNameSchema, headerValueSchema);

const resourceAttributesSchema = z.record(
  z.string().trim().min(1).max(128),
  z.string().max(512),
);

const sourceTypesSchema = z
  .array(z.enum(["eval", "scenario", "swarm", "direct"]))
  .min(1)
  .max(4);

const compressionSchema = z.enum(["gzip", "none"]);

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /**
   * HTTPS only, and the backend appends `/v1/traces` if the path does not
   * already end there. Checked loosely here — the backend's normalizer is the
   * authority and refuses private-network hosts, userinfo and fragments, none
   * of which a zod URL check would catch.
   */
  endpointUrl: z.string().trim().min(1).max(2048),
  headers: headersSchema.optional(),
  resourceAttributes: resourceAttributesSchema.optional(),
  sourceTypes: sourceTypesSchema.optional(),
  /**
   * Defaults to false. Prompts, outputs, tool arguments and screenshots are
   * REDACTED unless this is on — a destination that streams to a third party
   * should not carry customer content because nobody said otherwise.
   */
  includeContent: z.boolean().optional(),
  /** Omitted means every project in the organization. */
  projectIds: z.array(z.string().trim().min(1)).max(200).optional(),
  compression: compressionSchema.optional(),
  preset: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    endpointUrl: z.string().trim().min(1).max(2048).optional(),
    /** Present ⇒ REPLACES every header. Absent ⇒ the stored set is untouched. */
    headers: headersSchema.optional(),
    resourceAttributes: resourceAttributesSchema.optional(),
    sourceTypes: sourceTypesSchema.optional(),
    includeContent: z.boolean().optional(),
    projectIds: z.array(z.string().trim().min(1)).max(200).optional(),
    /**
     * The explicit way back to "every project". `projectIds: []` cannot mean
     * it — an empty allowlist is a destination that matches nothing, and the
     * two must not be spelled the same.
     */
    allProjects: z.boolean().optional(),
    compression: compressionSchema.optional(),
    preset: z.string().trim().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
  })
  .refine((value) => !(value.allProjects === true && value.projectIds), {
    message:
      "Send either `allProjects: true` or `projectIds`, not both — they are two answers to the same question.",
  });

const backfillSchema = z.strictObject({
  /**
   * How far back to replay. Clamped to [1, 30] by the backend; stated here so
   * the caller learns the bound at the boundary.
   */
  days: z.number().int().min(1).max(30),
});

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

/**
 * Read one destination back after a write.
 *
 * A write that succeeded and then could not be read is not a failed write, so
 * this throws a plain read error rather than a write one: the destination
 * exists either way, and telling the caller their create failed would have
 * them retry it.
 */
async function readDestination(
  client: ReturnType<typeof createConvexClient>,
  destinationId: string,
): Promise<TraceDestinationRow> {
  let row: TraceDestinationRow | null;
  try {
    row = (await client.query(
      "traceDestinations:getDestination" as never,
      {
        destinationId,
      } as never,
    )) as TraceDestinationRow | null;
  } catch (error) {
    throw translateReadError(error);
  }
  if (!row) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "That trace destination no longer exists.",
    );
  }
  return row;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /v1/organizations/:organizationId/trace-destinations
traceDestinations.get(
  "/organizations/:organizationId/trace-destinations",
  async (c) => {
    const organizationId = c.req.param("organizationId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    let rows: TraceDestinationRow[];
    try {
      rows = ((await client.query(
        "traceDestinations:listDestinations" as never,
        { organizationId } as never,
      )) ?? []) as TraceDestinationRow[];
    } catch (error) {
      throw translateReadError(error);
    }
    return v1PageJson(c, rows.map(toTraceDestinationDto));
  },
);

// GET /v1/organizations/:organizationId/trace-destinations/:destinationId
//
// The organization id in the path is addressing, not authorization: the Convex
// getter reads the destination's OWN organization and checks membership
// against that, so an id from another org reads as NOT_FOUND rather than
// leaking that it exists.
traceDestinations.get(
  "/organizations/:organizationId/trace-destinations/:destinationId",
  async (c) => {
    const client = createConvexClient(await getConvexBearerForRequest(c));
    const row = await readDestination(client, c.req.param("destinationId"));
    return v1Resource(c, toTraceDestinationDto(row));
  },
);

// POST /v1/organizations/:organizationId/trace-destinations
//
// Header values cross exactly one boundary here. They are never logged, never
// echoed, and never returned — the 201 body is the same metadata DTO every
// read produces.
traceDestinations.post(
  "/organizations/:organizationId/trace-destinations",
  async (c) => {
    const organizationId = c.req.param("organizationId");
    const body = await parseBody(c, createSchema);
    const client = createConvexClient(await getConvexBearerForRequest(c));

    let destinationId: string;
    try {
      // An ACTION, not a mutation: encryption is Node-only in Convex, and this
      // is the one hop the header values make.
      destinationId = (await client.action(
        "traceDestinations:createDestination" as never,
        { organizationId, ...body } as never,
      )) as string;
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Trace destination" });
    }

    const row = await readDestination(client, destinationId);
    return v1Resource(c, toTraceDestinationDto(row), 201);
  },
);

// PATCH /v1/organizations/:organizationId/trace-destinations/:destinationId
//
// `headers` REPLACES the whole set; omitting it leaves the stored one alone.
// A rotated credential takes effect on the next delivery — within about a
// minute — because the drain re-reads the destination before every POST.
traceDestinations.patch(
  "/organizations/:organizationId/trace-destinations/:destinationId",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const body = await parseBody(c, updateSchema);
    const client = createConvexClient(await getConvexBearerForRequest(c));

    try {
      await client.action(
        "traceDestinations:updateDestination" as never,
        {
          destinationId,
          ...body,
        } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Trace destination" });
    }

    const row = await readDestination(client, destinationId);
    return v1Resource(c, toTraceDestinationDto(row));
  },
);

// DELETE /v1/organizations/:organizationId/trace-destinations/:destinationId
//
// Streaming stops immediately and anything still queued is discarded. Traces
// already delivered stay in the vendor's system — MCPJam cannot retract them,
// and the response must not imply otherwise.
traceDestinations.delete(
  "/organizations/:organizationId/trace-destinations/:destinationId",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const client = createConvexClient(await getConvexBearerForRequest(c));

    try {
      await client.mutation(
        "traceDestinations:deleteDestination" as never,
        {
          destinationId,
        } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Trace destination" });
    }

    return v1Resource(c, { id: destinationId, deleted: true });
  },
);

// POST …/:destinationId/test
//
// Bodyless: there is nothing to say about a test span beyond which destination.
// It returns as soon as the send is SCHEDULED, because the send itself is a
// network round trip to a third party. The outcome lands on the destination's
// `lastTest`, which the GET above returns.
traceDestinations.post(
  "/organizations/:organizationId/trace-destinations/:destinationId/test",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const client = createConvexClient(await getConvexBearerForRequest(c));

    try {
      await client.mutation(
        "traceDestinations:sendTestSpan" as never,
        {
          destinationId,
        } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Trace destination" });
    }

    return v1Resource(c, { id: destinationId, scheduled: true });
  },
);

// POST …/:destinationId/pause — bodyless, addressed entirely by the path.
traceDestinations.post(
  "/organizations/:organizationId/trace-destinations/:destinationId/pause",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const client = createConvexClient(await getConvexBearerForRequest(c));

    try {
      await client.mutation(
        "traceDestinations:pauseDestination" as never,
        {
          destinationId,
        } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Trace destination" });
    }

    const row = await readDestination(client, destinationId);
    return v1Resource(c, toTraceDestinationDto(row));
  },
);

// POST …/:destinationId/resume — bodyless.
//
// NOTHING WAS QUEUED WHILE PAUSED. The response carries `pausedSince` so a
// caller can size the gap and decide whether to backfill it; an unbounded
// backlog waiting for someone to notice would be worse than a gap the customer
// is told about.
traceDestinations.post(
  "/organizations/:organizationId/trace-destinations/:destinationId/resume",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const client = createConvexClient(await getConvexBearerForRequest(c));

    let result: { pausedSince: number | null };
    try {
      result = (await client.mutation(
        "traceDestinations:resumeDestination" as never,
        { destinationId } as never,
      )) as { pausedSince: number | null };
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Trace destination" });
    }

    const row = await readDestination(client, destinationId);
    return v1Resource(c, {
      ...toTraceDestinationDto(row),
      pausedSince: result?.pausedSince ?? null,
    });
  },
);

// POST …/:destinationId/backfills — replay a window of history.
//
// Refused while the destination is paused or disabled: enqueue skips both, so
// a backfill against one would scan the whole window and queue nothing.
traceDestinations.post(
  "/organizations/:organizationId/trace-destinations/:destinationId/backfills",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const body = await parseBody(c, backfillSchema);
    const client = createConvexClient(await getConvexBearerForRequest(c));

    let result: { jobId: string };
    try {
      result = (await client.mutation(
        "traceDestinations:startBackfill" as never,
        { destinationId, days: body.days } as never,
      )) as { jobId: string };
    } catch (error) {
      throw translateConvexWriteError(error, {
        resource: "Trace destination backfill",
      });
    }

    let jobs: BackfillJobRow[];
    try {
      jobs = ((await client.query(
        "traceDestinations:listBackfillJobs" as never,
        { destinationId } as never,
      )) ?? []) as BackfillJobRow[];
    } catch (error) {
      throw translateReadError(error);
    }

    const job = jobs.find((row) => row._id === result.jobId);
    if (!job) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "The backfill was started but could not be read back.",
      );
    }
    return v1Resource(c, toBackfillJobDto(job), 201);
  },
);

// GET …/:destinationId/backfills — the 20 most recent, newest first.
traceDestinations.get(
  "/organizations/:organizationId/trace-destinations/:destinationId/backfills",
  async (c) => {
    const destinationId = c.req.param("destinationId");
    const client = createConvexClient(await getConvexBearerForRequest(c));

    let jobs: BackfillJobRow[];
    try {
      jobs = ((await client.query(
        "traceDestinations:listBackfillJobs" as never,
        { destinationId } as never,
      )) ?? []) as BackfillJobRow[];
    } catch (error) {
      throw translateReadError(error);
    }
    return v1PageJson(c, jobs.map(toBackfillJobDto));
  },
);

export default traceDestinations;
