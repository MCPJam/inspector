/**
 * `POST …/server-features/observations`: the browser's MCP Apps bridge
 * observations for one project server (engineering spec v0.4, "3. Observed").
 *
 * Hosted mounts it at `/api/web/server-features`, local at
 * `/api/mcp/server-features`. Both authorize the caller for the server, ask
 * the `server-canvas` rollout for the caller, and write with
 * `source: "apps-bridge"`. The body holds Apps bridge feature ids, counts and
 * times only; any other id is refused. Both times are written as the moment
 * this server received the batch: the browser's clock is not trusted, and the
 * backend keeps the latest `lastSeenAt`, so a skewed or hand-made time could
 * hold "last seen" in the future.
 *
 * The context: local computes it from the server's live connection on the
 * local manager, as capture does. A hosted batch arrives with no connection,
 * so it takes the last context this instance saw live for the server and the
 * user the backend authorized for this request; another member's context is
 * never used. Without a context the batch is dropped and nothing is recorded.
 */
import { refuseMockServer } from "../../utils/mock-servers.js";

import { Hono, type Context } from "hono";
import { z } from "zod";
import { APPS_BRIDGE_FEATURE_IDS } from "@mcpjam/sdk";
import {
  authorizeServerAs,
  callerContextFromHono,
  handleRoute,
} from "../web/auth.js";
import {
  assertBearerToken,
  parseWithSchema,
  readJsonBody,
} from "../web/errors.js";
import { authorizeServerLocal } from "../../utils/local-server-resolver.js";
import { setRequestLogContext } from "../../utils/request-logger.js";
import { resolveServerCanvasRollout } from "../../utils/server-canvas-rollout.js";
import { hostedContextHash } from "../../services/server-canvas/connection-context.js";
import { localContextHash } from "../../services/server-canvas/observation-recorders.js";
import {
  getLocalConnectionScope,
  localConnectionKeysForServer,
} from "../../utils/mcp-connections.js";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  MAX_OBSERVATION_COUNT,
  MAX_OBSERVATIONS_PER_WRITE,
  convexObservationWriter,
  writeObservationBatch,
} from "../../services/server-canvas/observations.js";

const bridgeObservationSchema = z
  .object({
    featureId: z.string().refine((id) => APPS_BRIDGE_FEATURE_IDS.has(id), {
      message: "Not an MCP Apps feature id",
    }),
    count: z.number().int().min(1).max(MAX_OBSERVATION_COUNT),
    firstSeenAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine((entry) => entry.firstSeenAt <= entry.lastSeenAt, {
    message: "firstSeenAt is after lastSeenAt",
  });

export const bridgeObservationsSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128),
    /** Chosen by the browser so its own retry is the same write. */
    flushId: z.string().min(8).max(64),
    observations: z
      .array(bridgeObservationSchema)
      .min(1)
      .max(MAX_OBSERVATIONS_PER_WRITE),
  })
  .strict();

export type BridgeObservationsBody = z.infer<typeof bridgeObservationsSchema>;

/** The context of this project server's live connection on the local manager. */
function liveLocalContextHash(
  manager: MCPClientManager,
  projectId: string,
  serverId: string,
): string | undefined {
  for (const key of localConnectionKeysForServer(manager, serverId)) {
    if (getLocalConnectionScope(manager, key)?.projectId !== projectId)
      continue;
    const hash = localContextHash(manager, key);
    if (hash) return hash;
  }
  return undefined;
}

/**
 * `authorizeServer` that also resolves to the user the backend authorized
 * (its Convex user id), when the backend named one.
 */
async function authorizeHostedActor(
  c: Context,
  bearer: string,
  body: BridgeObservationsBody,
): Promise<string | undefined> {
  let actorId: string | undefined;
  const authorized = await authorizeServerAs(
    {
      caller: callerContextFromHono(c),
      onLogContext: (log) => {
        actorId = log.userId ?? undefined;
        setRequestLogContext(c, log);
      },
    },
    bearer,
    body.projectId,
    body.serverId,
  );
  refuseMockServer(
    authorized,
    "Feature observations do not take mock servers. A mock has no features of its own to record. Open the server the mock is based on to record them.",
  );
  return actorId;
}

async function recordBridgeObservations(args: {
  bearer: string;
  body: BridgeObservationsBody;
  /** Authorizes the caller; resolves to the context to file under, if any. */
  authorizedContext: () => Promise<string | undefined>;
}): Promise<{ recorded: number }> {
  const { bearer, body } = args;
  const receivedAt = Date.now();
  if (!(await resolveServerCanvasRollout(bearer))) return { recorded: 0 };
  const contextHash = await args.authorizedContext();
  if (!contextHash) return { recorded: 0 };
  const saved = await writeObservationBatch(convexObservationWriter(bearer), {
    projectId: body.projectId,
    serverId: body.serverId,
    contextHash,
    flushId: body.flushId,
    observations: body.observations.map(({ featureId, count }) => ({
      featureId,
      count,
      firstSeenAt: receivedAt,
      lastSeenAt: receivedAt,
      source: "apps-bridge" as const,
    })),
  });
  return { recorded: saved ? body.observations.length : 0 };
}

/** Mounted at `/api/web/server-features`. */
export const hostedServerFeatureRoutes = new Hono().post("/observations", (c) =>
  handleRoute(c, async () => {
    const bearer = assertBearerToken(c);
    const body = parseWithSchema(
      bridgeObservationsSchema,
      await readJsonBody(c),
    );
    return recordBridgeObservations({
      bearer,
      body,
      authorizedContext: async () => {
        const actorId = await authorizeHostedActor(c, bearer, body);
        return actorId
          ? hostedContextHash({
              projectId: body.projectId,
              serverId: body.serverId,
              actorId,
            })
          : undefined;
      },
    });
  }),
);

/** Mounted at `/api/mcp/server-features`. */
export const localServerFeatureRoutes = new Hono().post("/observations", (c) =>
  handleRoute(c, async () => {
    const bearer = assertBearerToken(c);
    const body = parseWithSchema(
      bridgeObservationsSchema,
      await readJsonBody(c),
    );
    return recordBridgeObservations({
      bearer,
      body,
      authorizedContext: async () => {
        await authorizeServerLocal(c, bearer, body.projectId, body.serverId);
        return liveLocalContextHash(
          c.mcpClientManager,
          body.projectId,
          body.serverId,
        );
      },
    });
  }),
);
