/**
 * What both connect paths (local `executeLocalServerConnect`, hosted
 * `validateServerCore`) do with a successful connection's inspection.
 *
 * `recordConnectInspection` captures while the connection is live and starts
 * the Convex write in the background; neither connect response waits on
 * Convex. With `server-canvas` off it writes the v2 tool snapshot exactly as
 * before. With it on it writes the v3 snapshot with its capture context, then
 * hands the event to `onCanvasConnect`, the place later canvas work after
 * connect (background probes) joins.
 */
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionArgs } from "convex/server";
import type {
  CaptureContext,
  MCPClientManager,
  OAuthFlowSummary,
} from "@mcpjam/sdk";
import { getInspectorClientRuntimeConfig } from "../../env.js";
import { exportSingleServerForInspection } from "../../utils/export-helpers.js";
import { logger } from "../../utils/logger.js";
import { getManagerConnections } from "../../utils/mcp-connections.js";
import { captureServerFeatures, type ServerFeatureCapture } from "./capture.js";

export interface CanvasConnectEvent {
  /**
   * True for hosted validate. Its manager is ephemeral: the route disconnects
   * it as soon as `validateServerCore` returns, so work that needs the
   * connection must finish before `recordConnectInspection` resolves. The
   * local manager keeps the connection.
   */
  hosted: boolean;
  projectId: string;
  /** Project server id (the Convex `servers` id). */
  serverId: string;
  /** The connection's key in `manager`. */
  managerKey: string;
  manager: MCPClientManager;
  /** The connecting user's bearer for Convex writes; absent means no write. */
  convexBearer: string | undefined;
  serverUrl?: string;
  capture: ServerFeatureCapture;
  /** Non-secret summary of the OAuth flow that preceded this connect. */
  oauthFlow?: OAuthFlowSummary;
}

export interface ConnectInspectionInput
  extends Omit<CanvasConnectEvent, "capture"> {
  /** `resolveServerCanvasRollout` for this request, started early. */
  canvasRollout: Promise<boolean>;
  /** An OAuth connection or credential id for the context; never a token. */
  accountKey?: string;
  /** A cancelled connect stops the capture's listing and skips the write. */
  signal?: AbortSignal;
  logPrefix: string;
}

/**
 * How long the capture waits for a rollout answer still in flight (it asks
 * PostHog and Convex). Past it, this connect takes the off path.
 */
const ROLLOUT_WAIT_MS = 1_000;

async function rolloutWithin(rollout: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ROLLOUT_WAIT_MS);
  });
  try {
    return await Promise.race([rollout.catch(() => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** `captureContext` and its hash ride with v3 snapshots only. */
const recordFromConnect = makeFunctionReference<
  "mutation",
  {
    projectId: string;
    snapshot: unknown;
    captureContext?: CaptureContext;
    captureContextHash?: string;
  }
>("serverInspections:recordFromConnect");

async function writeInspection(
  convexBearer: string | undefined,
  args: FunctionArgs<typeof recordFromConnect>,
): Promise<void> {
  // Only `CONVEX_HTTP_URL` is boot-enforced; the convex-client URL is
  // derived from it (suffix swap) by the runtime config helper so that
  // production env (which sets only CONVEX_HTTP_URL) works.
  const { convexUrl } = getInspectorClientRuntimeConfig();
  const bearer = convexBearer?.replace(/^Bearer\s+/i, "");
  if (!convexUrl || !bearer) return;
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(bearer);
  await client.mutation(recordFromConnect, args);
}

function logWriteFailure(input: { logPrefix: string; managerKey: string }) {
  return (error: unknown) =>
    logger.debug(`[${input.logPrefix}] Failed to persist connect-time inspection`, {
      serverId: input.managerKey,
      error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * Canvas work after a v3 capture: today, the inspection write with its
 * capture context. Never throws, and no connect response waits on it.
 */
export async function onCanvasConnect(event: CanvasConnectEvent): Promise<void> {
  await writeInspection(event.convexBearer, {
    projectId: event.projectId,
    snapshot: event.capture.snapshot,
    captureContext: event.capture.context,
    captureContextHash: event.capture.contextHash,
  }).catch(
    logWriteFailure({ logPrefix: "server-canvas", managerKey: event.managerKey }),
  );
}

function defaultConnectionId(
  manager: MCPClientManager,
  managerKey: string,
): string | undefined {
  return getManagerConnections(manager)?.[managerKey]?.find(
    (connection) => connection.isDefault,
  )?.connectionId;
}

/**
 * Captures the connected server and starts its inspection write. Resolves
 * once the capture is done, with whether the canvas rollout was on for it.
 * Never throws.
 */
export async function recordConnectInspection(
  input: ConnectInspectionInput,
): Promise<{ canvas: boolean }> {
  const { manager, managerKey, serverId, logPrefix } = input;
  const canvas = await rolloutWithin(input.canvasRollout);
  if (!canvas) {
    const snapshot = await exportSingleServerForInspection(
      manager,
      managerKey,
      serverId,
      { logPrefix },
    );
    if (input.signal?.aborted) return { canvas };
    void writeInspection(input.convexBearer, {
      projectId: input.projectId,
      snapshot,
    }).catch(logWriteFailure(input));
    return { canvas };
  }
  const capture = await captureServerFeatures(manager, managerKey, serverId, {
    accountKey: input.accountKey ?? defaultConnectionId(manager, managerKey),
    logPrefix,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (input.signal?.aborted) return { canvas };
  void onCanvasConnect({
    hosted: input.hosted,
    projectId: input.projectId,
    serverId,
    managerKey,
    manager,
    convexBearer: input.convexBearer,
    ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    capture,
    ...(input.oauthFlow ? { oauthFlow: input.oauthFlow } : {}),
  });
  return { canvas };
}
