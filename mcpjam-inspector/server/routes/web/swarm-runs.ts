import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  createAuthorizedManager,
  callerContextFromHono,
} from "./auth.js";
import {
  getConvexBearerForRequest,
  getConvexBearerThunkForRequest,
} from "../../utils/v1-convex-token.js";
import { WEB_STREAM_TIMEOUT_MS, HOSTED_MODE } from "../../config.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { getRunningJourneyStreamHub } from "../../services/sessionSimulation/swarm-runner.js";
import { launchJourneyRun } from "../../services/sessionSimulation/launch-journey-run.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import type { SwarmStreamEvent } from "../../../shared/swarm-stream-events.js";
import { logger } from "../../utils/logger.js";
import { assertBearerToken } from "./errors.js";

const swarmRuns = new Hono();

const sseEncoder = new TextEncoder();

function encodeSseEvent(event: SwarmStreamEvent): Uint8Array {
  return sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Multiplexed live stream for one journey run. Late joiners receive the
 * in-memory ring buffer then live events until `run_complete`.
 */
swarmRuns.get("/runs/:runId/stream", async (c) => {
  assertBearerToken(c);
  const runId = c.req.param("runId");
  if (!runId) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "runId required");
  }

  // AUTHORIZATION. `assertBearerToken` proves the caller is *someone*; it says
  // nothing about whether this run is theirs. Without the check below, any
  // authenticated user who knew (or guessed) a run id could subscribe to
  // another organization's live journey stream — which carries full session
  // transcripts, tool calls and tool results as they happen.
  //
  // `journeyRuns:getJourneyRun` is the authority: it resolves the run and
  // enforces project membership, so a run in someone else's project comes back
  // null (or throws) exactly like one that does not exist. Both collapse to
  // 404 here, so this route is not an existence oracle either.
  //
  // Deliberately BEFORE `getRunningJourneyStreamHub`: the hub is in-process
  // state, and subscribing first would leak events for the window between
  // subscribe and rejection.
  const bearerToken = await getConvexBearerForRequest(c);
  let authorized = false;
  try {
    const run = await createConvexClient(bearerToken).query(
      "journeyRuns:getJourneyRun" as never,
      { runId } as never
    );
    authorized = run != null;
  } catch (error) {
    // Membership failure, malformed id, or Convex unreachable. Fail CLOSED —
    // a stream is not worth serving on an unverified authorization.
    //
    // LOGGED, because this branch also swallows the causes that are ours:
    // `createConvexClient` throws outright with `CONVEX_URL` unset, and an
    // unreachable Convex lands here too. Silent, both of those make every
    // stream in the deployment answer 404, which reads to an operator as "the
    // runs disappeared" rather than "the dependency is down". The response
    // stays 404 either way — only the record changes.
    logger.warn("[swarm-runs] stream authorization lookup failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    authorized = false;
  }
  if (!authorized) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Run not found");
  }

  const hub = getRunningJourneyStreamHub(runId);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!hub) {
        // Run already finished (or never started on this process). Clients
        // fall back to Convex + blobs for history.
        try {
          controller.enqueue(
            encodeSseEvent({
              type: "run_complete",
              runId,
              hostId: "",
              chatSessionId: "",
              sessionIndex: -1,
            })
          );
          controller.close();
        } catch {
          // ignore
        }
        return;
      }

      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      unsubscribe = hub.subscribe((event) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseEvent(event));
          if (event.type === "run_complete") {
            close();
          }
        } catch {
          close();
        }
      });

      c.req.raw.signal.addEventListener("abort", close, { once: true });
    },
  });

  return c.body(stream as any, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
});

const startRunSchema = z.object({
  projectId: z.string().min(1),
  launchKey: z.string().min(1),
  /**
   * Opaque wave id linking the sibling runs of one co-launched swarm. Optional
   * so an older client simply omits it; bounded here to match the backend's
   * own cap rather than forwarding an unbounded string.
   */
  swarmRunGroupId: z.string().min(1).max(64).optional(),
  /**
   * Per-run environment fan-out. Shape-checked here; the backend does the real
   * validation (live, in-project, duplicate-free, capped) inside the launch
   * transaction, since only it can see the project's environments.
   */
  environmentIds: z.array(z.string().min(1)).optional(),
});

/**
 * Launch a multi-host swarm (journey-execution) run (PR 3d).
 *
 * Creates a journey run (the backend pins the journey's full host set — no
 * `maxHosts` cap; a backend rejection such as a hard host-count ceiling or a
 * journey with no hosts surfaces as a 4xx), then starts the fan-out runner
 * fire-and-forget and returns HTTP 202 with the runId. This is the route the
 * enabled "Run journey" button in the UI calls.
 */
swarmRuns.post("/journeys/:journeyId/runs", async (c) =>
  handleRoute(
    c,
    async () => {
      // `/journey-execution/*` (like every Convex HTTP action) is JWT-only.
      // A WorkOS API-key caller (`sk_…`) accepted by the route middleware has
      // no usable JWT, so forward the delegated short-lived JWT the rest of the
      // `/api/v1`-reachable surface uses — `getConvexBearerForRequest` returns
      // the original bearer verbatim for session/guest JWTs and mints a
      // delegated JWT for API-key callers. Without this, an API-key launch
      // forwards the raw `sk_…` and every downstream action 401s.
      const bearerToken = await getConvexBearerForRequest(c);
      // The runner detaches after the 202 and can fan out for hours, while a
      // delegated JWT lives ~2h — so it gets a THUNK, resolved while `c` is
      // still live, not the string above. Everything that stays inside this
      // request keeps using `bearerToken`.
      const getRunBearer = getConvexBearerThunkForRequest(c);
      const journeyId = c.req.param("journeyId");
      if (!journeyId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "journeyId required"
        );
      }
      const body = parseWithSchema(
        startRunSchema,
        await readJsonBody<unknown>(c)
      );
      return launchJourneyRun(
        {
          bearerToken,
          getRunBearer,
          // Resolved HERE, while the request Context is still live: it reads
          // `x-forwarded-proto`, and the runner that needs it runs after the
          // 202, by which point the Context may be finalized.
          xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
          callerContext: callerContextFromHono(c),
        },
        {
          projectId: body.projectId,
          journeyRefId: journeyId,
          launchKey: body.launchKey,
          ...(body.swarmRunGroupId ? { waveId: body.swarmRunGroupId } : {}),
          ...(body.environmentIds?.length
            ? { environmentIds: body.environmentIds }
            : {}),
        }
      );
    },
    202
  )
);

export default swarmRuns;
