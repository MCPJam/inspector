/**
 * Background probes after a canvas capture: decide whether this context is
 * due, recheck the `server-canvas` rollout, run the probes, and store the
 * results with the capture's context and any OAuth-flow summary.
 *
 * Never throws and never blocks a connect on its own: the caller decides how
 * long to wait. A hosted connect waits for `connectionReleased`, the point
 * after which its ephemeral connection may close; HTTP probes and the write
 * continue after that.
 *
 * After a failed capture the run is stored with `attemptError`
 * {@link CAPTURE_FAILED_ATTEMPT}, its list-based probes report `failed` so the
 * last good results stay, and the cadence is left unmarked so the next connect
 * probes again. The same goes for a run whose connection-bound probes failed,
 * or, locally, whose connection was replaced while they ran. When the probes
 * are not due, an OAuth-flow summary is still stored on its own. A write whose
 * arguments the backend refuses is tried once more without the summary, so a
 * summary it will not take never costs the probe results.
 */
import { ConvexError } from "convex/values";
import type { ProbeSummary, ServerProbeId } from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import { resolveServerCanvasRollout } from "../../utils/server-canvas-rollout.js";
import { captureFailed } from "./capture.js";
import type { CanvasConnectEvent } from "./connect-hook.js";
import { probeCadence, type ProbeCadence } from "./probe-cadence.js";
import {
  CAPTURE_FAILED_ATTEMPT,
  writeProbeResults,
  type ProbeResultsWrite,
} from "./probe-results.js";
import {
  HOSTED_CONNECTION_PROBE_BUDGET_MS,
  runServerProbes,
  type ProbeRunnerDependencies,
} from "./probe-runner.js";
import { rolloutWithin } from "./rollout-within.js";

export interface CanvasProbeOptions {
  /** Refresh runs whatever the cadence says. */
  force?: boolean;
  /** Called with the handle as soon as the probes start; Refresh waits on it. */
  onStarted?: (probes: CanvasProbeHandle) => void;
}

export interface CanvasProbeDependencies extends ProbeRunnerDependencies {
  rollout?: (authorization: string | undefined) => Promise<boolean>;
  write?: typeof writeProbeResults;
  cadence?: ProbeCadence;
}

export interface CanvasProbeHandle {
  /**
   * The connection-bound probes are done or abandoned and the connection may
   * close. Hosted, this resolves at most the hosted budget after the probes
   * start, whatever they are doing, so a connect never waits longer.
   */
  connectionReleased: Promise<void>;
  /** Probes ran and were stored, or were skipped. Never rejects. */
  done: Promise<void>;
}

export type CanvasProbeOutcome =
  | "stored"
  | "not-due"
  | "already-running"
  | "rollout-off"
  | "no-bearer"
  /** There was nowhere to write: the Inspector has no Convex URL. */
  | "no-convex-url"
  | "write-failed";

/**
 * How long a rollout recheck may take. Past it the probes are skipped as if
 * the rollout were off, so a hosted connect is never held for the answer and
 * the context's claim is let go for the next connect.
 */
const ROLLOUT_RECHECK_WAIT_MS = 2_000;

/** The probes `runServerProbes` runs on the live connection. */
const CONNECTION_PROBES: ReadonlySet<ServerProbeId> = new Set([
  "apps-ui-resources",
  "skills",
  "events-list",
]);

/** Starts the probes for one capture; see {@link CanvasProbeHandle}. */
export function startCanvasProbes(
  event: CanvasConnectEvent,
  options: CanvasProbeOptions = {},
  dependencies: CanvasProbeDependencies = {},
): CanvasProbeHandle & { outcome: Promise<CanvasProbeOutcome> } {
  let release: () => void = () => undefined;
  const connectionReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Hosted, the connection is let go at the budget whatever the probes do.
  // The cap is armed after the probes' own deadline, which starts after the
  // rollout recheck, so the route never closes the connection under a probe
  // that still has time.
  const armCap = () => {
    if (!event.hosted) return;
    const cap = setTimeout(() => release(), HOSTED_CONNECTION_PROBE_BUDGET_MS);
    void connectionReleased.then(() => clearTimeout(cap));
  };
  const outcome = runCanvasProbes(event, options, dependencies, {
    started: armCap,
    connectionBound: () => release(),
  })
    .catch((error: unknown): CanvasProbeOutcome => {
      logger.warn("[server-canvas] background probes were not stored", {
        serverId: event.serverId,
        error: error instanceof Error ? error.name : typeof error,
      });
      return "write-failed";
    })
    .finally(() => release());
  const handle = {
    connectionReleased,
    done: outcome.then(() => undefined),
    outcome,
  };
  options.onStarted?.(handle);
  return handle;
}

function writeArgs(event: CanvasConnectEvent): Omit<ProbeResultsWrite, "probes"> {
  return {
    projectId: event.projectId,
    serverId: event.serverId,
    contextHash: event.capture.contextHash,
    captureContext: event.capture.context,
    ...(event.oauthFlow ? { oauthFlow: event.oauthFlow } : {}),
  };
}

/** The `server-canvas` rollout for this event's bearer, bounded in time. */
function rolloutOn(
  event: CanvasConnectEvent,
  dependencies: CanvasProbeDependencies,
): Promise<boolean> {
  const rollout = dependencies.rollout ?? resolveServerCanvasRollout;
  return rolloutWithin(rollout(event.convexBearer), ROLLOUT_RECHECK_WAIT_MS);
}

/**
 * Whether the backend refused the write's arguments, the one failure that
 * leaving the OAuth summary out can fix. Convex's argument validator refuses
 * before the handler runs, as a plain error whose message names
 * `ArgumentValidationError`; the handler's own evidence checks throw a
 * `ConvexError` with code `INVALID_ARGUMENT`. A network, auth or server error
 * is neither.
 */
function argumentsRefused(error: unknown): boolean {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    return (
      typeof data === "object" &&
      data !== null &&
      "code" in data &&
      data.code === "INVALID_ARGUMENT"
    );
  }
  return error instanceof Error && /\bArgumentValidationError\b/.test(error.message);
}

/**
 * Writes a probe run. A run whose arguments the backend refuses while it
 * carries an OAuth summary is written once more without it: the summary is
 * the part the Inspector cannot fully check, and the probe results must not
 * be lost to it. Any other failure is thrown as it is.
 */
async function store(
  event: CanvasConnectEvent,
  dependencies: CanvasProbeDependencies,
  args: ProbeResultsWrite,
): Promise<boolean> {
  const write = dependencies.write ?? writeProbeResults;
  try {
    return await write(event.convexBearer, args);
  } catch (error) {
    const { oauthFlow, ...withoutSummary } = args;
    if (!oauthFlow || !argumentsRefused(error)) throw error;
    logger.warn("[server-canvas] probe write arguments refused; retrying without the OAuth summary", {
      serverId: event.serverId,
      error: error instanceof Error ? error.name : typeof error,
    });
    return write(event.convexBearer, withoutSummary);
  }
}

/** Probes skipped by the cadence: store the OAuth summary alone, if any. */
async function storeSummaryAlone(
  event: CanvasConnectEvent,
  dependencies: CanvasProbeDependencies,
  skipped: "not-due" | "already-running",
): Promise<CanvasProbeOutcome> {
  if (!event.oauthFlow) return skipped;
  if (!(await rolloutOn(event, dependencies))) return "rollout-off";
  const stored = await (dependencies.write ?? writeProbeResults)(event.convexBearer, {
    ...writeArgs(event),
    probes: [],
  });
  return stored ? skipped : "no-convex-url";
}

/** The connection's client now, to tell whether a run saw it replaced. */
function liveClient(event: CanvasConnectEvent): unknown {
  try {
    return event.manager.getManagedClient(event.managerKey);
  } catch {
    // A manager that cannot report a client has none to compare.
    return undefined;
  }
}

/** Whether a connection-bound probe failed, so the run says less than it should. */
function connectionProbeFailed(probes: ProbeSummary[]): boolean {
  return probes.some(
    (probe) => CONNECTION_PROBES.has(probe.probeId) && probe.status === "failed",
  );
}

async function runCanvasProbes(
  event: CanvasConnectEvent,
  options: CanvasProbeOptions,
  dependencies: CanvasProbeDependencies,
  signals: { started: () => void; connectionBound: () => void },
): Promise<CanvasProbeOutcome> {
  if (!event.convexBearer) return "no-bearer";
  const now = dependencies.now ?? Date.now;
  const cadence = dependencies.cadence ?? probeCadence;
  const key = {
    projectId: event.projectId,
    serverId: event.serverId,
    contextHash: event.capture.contextHash,
  };
  // Skipped probes need no connection: let it go before anything is awaited.
  if (!options.force && !cadence.isDue(key, now())) {
    signals.connectionBound();
    return storeSummaryAlone(event, dependencies, "not-due");
  }
  if (!cadence.begin(key)) {
    signals.connectionBound();
    return storeSummaryAlone(event, dependencies, "already-running");
  }
  try {
    // The decision that started this work may be stale by now.
    if (!(await rolloutOn(event, dependencies))) return "rollout-off";
    // Local connections live on: a reconnect during the run swaps the client.
    const clientAtStart = event.hosted ? undefined : liveClient(event);
    const run = runServerProbes(
      {
        hosted: event.hosted,
        manager: event.manager,
        managerKey: event.managerKey,
        serverUrl: event.serverUrl,
        capture: event.capture,
      },
      dependencies,
    );
    signals.started();
    void run.connectionBound.then(signals.connectionBound);
    const clientAtEnd = run.connectionBound.then(() =>
      event.hosted ? undefined : liveClient(event),
    );
    const probes = await run.summaries;
    if (!(await rolloutOn(event, dependencies))) return "rollout-off";
    const failed = captureFailed(event.capture);
    const stored = await store(event, dependencies, {
      ...writeArgs(event),
      probes,
      ...(failed ? { attemptError: CAPTURE_FAILED_ATTEMPT } : {}),
    });
    if (!stored) return "no-convex-url";
    // After a failed capture, a failed connection-bound probe or a reconnect
    // during the run, the next connect probes again.
    const reconnected = (await clientAtEnd) !== clientAtStart;
    if (!failed && !connectionProbeFailed(probes) && !reconnected) {
      cadence.record(key, now());
    }
    return "stored";
  } finally {
    cadence.end(key);
  }
}
