/**
 * Refresh for the server canvas: a fresh v3 capture of a connected server,
 * its inspection write and a forced probe run, behind `server-canvas`.
 *
 * The page watches Convex for the results. Locally it uses the persistent
 * connection and the route answers once the work is queued. Hosted it uses an
 * ephemeral connection the route opened: `runCanvasRefresh` resolves once the
 * probes no longer need it, so the route can close it, and the route answers
 * when `done` settles, so the request holds its server-check slot for all of
 * the refresh's egress.
 *
 * One refresh runs at a time per verified caller and project server in this
 * process (`claimCanvasRefresh`); a second one joins the first.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import { resolveServerCanvasRollout } from "../../utils/server-canvas-rollout.js";
import type { CanvasProbeHandle } from "./canvas-probes.js";
import { captureServerFeatures } from "./capture.js";
import { captureAccountKey, onCanvasConnect } from "./connect-hook.js";
import { suppressFeatureObservation } from "@mcpjam/sdk";

export interface CanvasRefreshTarget {
  hosted: boolean;
  projectId: string;
  /** Project server id. */
  serverId: string;
  manager: MCPClientManager;
  managerKey: string;
  /** The caller's bearer, for the rollout check and the Convex writes. */
  convexBearer: string;
  /** An OAuth connection or credential id for the context; never a token. */
  accountKey?: string;
}

export interface CanvasRefreshDependencies {
  rollout?: (authorization: string) => Promise<boolean>;
  capture?: typeof captureServerFeatures;
  afterCapture?: typeof onCanvasConnect;
}

export type CanvasRefreshOutcome = "started" | "rollout-off" | "failed";

export interface CanvasRefreshRun {
  outcome: CanvasRefreshOutcome;
  /** The probes were stored or skipped, or the refresh ended early. Never rejects. */
  done: Promise<void>;
}

const refreshing = new Set<string>();

/**
 * Claims the refresh of one project server for one caller. Returns the
 * release, or `undefined` while a refresh for the same key is running. Keyed
 * by caller too, so one member's refresh never swallows another's: each lands
 * in its caller's capture context. A route claims only after the caller is
 * authorized for the server, and `caller` must name a verified principal: a
 * route without one (an unverified passthrough bearer) skips the claim rather
 * than share one key among every such caller.
 *
 * The claim lives in this process. With several hosted replicas a second
 * refresh starts nothing only when it reaches the same replica; the
 * server-check slots still cap a caller's concurrent refreshes in total.
 */
export function claimCanvasRefresh(key: {
  caller: string;
  projectId: string;
  serverId: string;
}): (() => void) | undefined {
  const id = JSON.stringify([key.caller, key.projectId, key.serverId]);
  if (refreshing.has(id)) return undefined;
  refreshing.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refreshing.delete(id);
  };
}

/**
 * Rechecks the rollout, captures, then hands off to the connect path's canvas
 * work with the cadence bypassed. Resolves when the connection may close
 * (hosted) or once the work is queued (local). Never throws. Observation is
 * paused on the connection until then: this is MCPJam's own traffic.
 */
export function runCanvasRefresh(
  target: CanvasRefreshTarget,
  dependencies: CanvasRefreshDependencies = {},
): Promise<CanvasRefreshRun> {
  return suppressFeatureObservation(target.manager, target.managerKey, () =>
    refreshCanvas(target, dependencies),
  );
}

async function refreshCanvas(
  target: CanvasRefreshTarget,
  dependencies: CanvasRefreshDependencies,
): Promise<CanvasRefreshRun> {
  const ended = (outcome: CanvasRefreshOutcome): CanvasRefreshRun => ({
    outcome,
    done: Promise.resolve(),
  });
  try {
    const rollout = dependencies.rollout ?? resolveServerCanvasRollout;
    // Queued work starts only while the rollout is still on.
    if (!(await rollout(target.convexBearer))) return ended("rollout-off");
    const { manager, managerKey } = target;
    const capture = await (dependencies.capture ?? captureServerFeatures)(
      manager,
      managerKey,
      target.serverId,
      {
        accountKey: captureAccountKey(manager, managerKey, target.accountKey),
        logPrefix: "server-canvas-refresh",
      },
    );
    const config = manager.getServerConfig(managerKey);
    const url = config && "url" in config ? config.url : undefined;
    const started: { probes?: CanvasProbeHandle } = {};
    await (dependencies.afterCapture ?? onCanvasConnect)(
      {
        hosted: target.hosted,
        projectId: target.projectId,
        serverId: target.serverId,
        managerKey,
        manager,
        convexBearer: target.convexBearer,
        ...(url ? { serverUrl: String(url) } : {}),
        capture,
      },
      {
        force: true,
        onStarted: (handle) => {
          started.probes = handle;
        },
      },
    );
    return { outcome: "started", done: started.probes?.done ?? Promise.resolve() };
  } catch (error) {
    logger.warn("[server-canvas] refresh failed", {
      serverId: target.serverId,
      error: error instanceof Error ? error.name : typeof error,
    });
    return ended("failed");
  }
}
