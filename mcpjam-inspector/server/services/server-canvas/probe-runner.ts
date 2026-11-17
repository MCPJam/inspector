/**
 * Runs the six background probes (`SERVER_PROBE_IDS`) for one connection and
 * returns one summary per probe.
 *
 * Two phases. Connection-bound probes (Apps reads, `events/list`, skill
 * verification) use the live connection and must finish before a hosted
 * ephemeral connection closes, so they share one budget; whatever has not
 * finished when it runs out is recorded as `abandoned` and its reads are
 * aborted. For that window the input guard keeps the server's requests for
 * user input from reaching the user. HTTP probes (transport, authorization,
 * Server Card) never touch the connection and run on their own, longer
 * budget. A stdio server's HTTP probes are `not-applicable`.
 *
 * The Apps and skills probes work from the capture's lists; when the capture
 * could not list what they need they report `failed` without running, so the
 * stored results from the last good capture stay.
 *
 * Every probe is read-only: `events/list`, `skills/get`, `resources/read` of
 * the server's own `ui://` resources and sampled SKILL.md files,
 * unauthenticated metadata GETs and one unauthenticated initialize. A probe
 * that throws becomes a `failed` summary; nothing here throws, and no probe's
 * failure affects another's.
 */
import {
  SERVER_PROBE_IDS,
  isBackgroundSafeCheck,
  isConformanceCheckRef,
  type CheckStatus,
  type ConformanceCheckRef,
  type MCPClientManager,
  type ProbeSummary,
  type ServerProbeId,
} from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import type { RunDiscoveryPreflightDependencies } from "../server-connection-discovery.js";
import type { ServerFeatureCapture } from "./capture.js";
import {
  plannedUiResourceUris,
  runAppsProbe,
  type AppsProbeDependencies,
} from "./probes/apps-probe.js";
import { runEventsProbe, type EventsProbeDependencies } from "./probes/events-probe.js";
import { guardProbeInput } from "./probes/input-guard.js";
import { runHttpProbes } from "./probes/http-probes.js";
import { serverOnPrivateNetwork } from "./probes/private-target.js";
import { runServerCardProbe } from "./probes/server-card-probe.js";
import { unranProbe } from "./probes/shared.js";
import { runSkillsProbe, skillsToVerify } from "./probes/skills-probe.js";

/** Hosted: the ephemeral connection closes when this runs out. */
export const HOSTED_CONNECTION_PROBE_BUDGET_MS = 3_000;
export const LOCAL_CONNECTION_PROBE_BUDGET_MS = 15_000;
export const HTTP_PROBE_BUDGET_MS = 45_000;

export interface ProbeTarget {
  hosted: boolean;
  manager: MCPClientManager;
  managerKey: string;
  /** The HTTP server's configured URL; absent for stdio. */
  serverUrl?: string;
  capture: ServerFeatureCapture;
}

export interface ProbeRunnerDependencies
  extends AppsProbeDependencies,
    EventsProbeDependencies,
    Pick<RunDiscoveryPreflightDependencies, "probeServer"> {
  /** Dials the HTTP probes; the pinned transport when absent. */
  fetchFn?: typeof fetch;
  /** Whether the server is on a private network; resolves it when absent. */
  privateTarget?: (serverUrl: string) => Promise<boolean>;
  now?: () => number;
  connectionBudgetMs?: number;
  httpBudgetMs?: number;
}

export interface ProbeRun {
  /** The connection-bound probes are done or abandoned; the connection may close. */
  connectionBound: Promise<void>;
  /** One summary per probe id, in `SERVER_PROBE_IDS` order. Never rejects. */
  summaries: Promise<ProbeSummary[]>;
}

const EXPIRED = Symbol("expired");
const STDIO_DETAIL = "Applies to HTTP servers. This server runs over stdio.";
const NO_URL_DETAIL = "The server URL was not available to probe.";
const OUT_OF_TIME = "The probe ran out of time.";
const THREW = "The probe stopped with an error.";

function deadline(ms: number, controller: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(EXPIRED);
    }, ms);
  });
  return { expired, clear: () => clearTimeout(timer) };
}

/** Only background-safe checks survive, whatever a probe reported. */
function safeChecks(
  checks: ProbeSummary["checks"],
): ProbeSummary["checks"] | undefined {
  if (!checks) return undefined;
  const kept: Partial<Record<ConformanceCheckRef, CheckStatus>> = {};
  for (const [ref, status] of Object.entries(checks)) {
    if (status && isConformanceCheckRef(ref) && isBackgroundSafeCheck(ref)) {
      kept[ref] = status;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

async function settle<P extends ServerProbeId>(
  probeId: P,
  work: () => Promise<ProbeSummary<P>>,
  expired: Promise<typeof EXPIRED>,
  now: () => number,
): Promise<ProbeSummary<P>> {
  let running: Promise<ProbeSummary<P>>;
  try {
    running = work();
  } catch (error) {
    running = Promise.reject(error);
  }
  // Promise.race keeps a handler on `running`, so a probe that rejects after
  // its budget is not an unhandled rejection.
  try {
    const result = await Promise.race([running, expired]);
    if (result === EXPIRED) return unranProbe(probeId, "abandoned", now(), OUT_OF_TIME);
    const { checks, ...rest } = result;
    const kept = safeChecks(checks);
    return kept ? { ...rest, checks: kept } : rest;
  } catch (error) {
    // The name only: a message can carry URLs, headers or server text.
    logger.debug("[server-canvas] probe failed", {
      probeId,
      error: error instanceof Error ? error.name : typeof error,
    });
    return unranProbe(probeId, "failed", now(), THREW);
  }
}

/**
 * Whether the probes have anything to do on the connection: UI resources to
 * read, skills to verify, or events to list. A hosted connect waits for the
 * probes only when there is.
 */
export function needsConnection(
  target: Pick<ProbeTarget, "manager" | "managerKey" | "capture">,
): boolean {
  const doctor = target.capture.doctor;
  if (
    doctor &&
    (plannedUiResourceUris(doctor).length > 0 || skillsToVerify(doctor).length > 0)
  ) {
    return true;
  }
  try {
    return target.manager.getEventsSupport(target.managerKey).declared;
  } catch {
    // A manager that cannot report events support has none to list.
    return false;
  }
}

export function runServerProbes(
  target: ProbeTarget,
  dependencies: ProbeRunnerDependencies = {},
): ProbeRun {
  const now = dependencies.now ?? Date.now;
  const { manager, managerKey, capture } = target;
  const doctor = capture.doctor;

  const connectionController = new AbortController();
  const connectionDeadline = deadline(
    dependencies.connectionBudgetMs ??
      (target.hosted
        ? HOSTED_CONNECTION_PROBE_BUDGET_MS
        : LOCAL_CONNECTION_PROBE_BUDGET_MS),
    connectionController,
  );
  const signal = connectionController.signal;
  const guard = guardProbeInput({
    hosted: target.hosted,
    manager,
    managerKey,
    context: capture.context,
  });
  const connectionProbes = Promise.all([
    settle(
      "apps-ui-resources",
      () =>
        runAppsProbe(
          { manager, managerKey, doctor, guard, signal, now },
          dependencies,
        ),
      connectionDeadline.expired,
      now,
    ),
    settle(
      "skills",
      () => runSkillsProbe({ manager, managerKey, doctor, guard, signal, now }),
      connectionDeadline.expired,
      now,
    ),
    settle(
      "events-list",
      () =>
        runEventsProbe(
          { manager, managerKey, readsAllowed: guard.readsAllowed, signal, now },
          dependencies,
        ),
      connectionDeadline.expired,
      now,
    ),
  ]).finally(() => {
    connectionDeadline.clear();
    guard.release();
  });

  const httpProbes = (async (): Promise<ProbeSummary[]> => {
    if (capture.context.transport === "stdio") {
      return [
        unranProbe("http-transport", "not-applicable", now(), STDIO_DETAIL),
        unranProbe("authorization", "not-applicable", now(), STDIO_DETAIL),
        unranProbe("server-card", "not-applicable", now(), STDIO_DETAIL),
      ];
    }
    const serverUrl = target.serverUrl;
    if (!serverUrl) {
      return [
        unranProbe("http-transport", "skipped", now(), NO_URL_DETAIL),
        unranProbe("authorization", "skipped", now(), NO_URL_DETAIL),
        unranProbe("server-card", "skipped", now(), NO_URL_DETAIL),
      ];
    }
    const httpController = new AbortController();
    const httpDeadline = deadline(
      dependencies.httpBudgetMs ?? HTTP_PROBE_BUDGET_MS,
      httpController,
    );
    // Hosted never dials a private address for a probe, whatever the server.
    const privateTarget =
      !target.hosted &&
      (await (dependencies.privateTarget ?? serverOnPrivateNetwork)(serverUrl));
    const pair = runHttpProbes(
      { serverUrl, now, privateTarget },
      { fetchFn: dependencies.fetchFn, probeServer: dependencies.probeServer },
    );
    try {
      return await Promise.all([
        settle(
          "http-transport",
          async () => (await pair).httpTransport,
          httpDeadline.expired,
          now,
        ),
        settle(
          "authorization",
          async () => (await pair).authorization,
          httpDeadline.expired,
          now,
        ),
        settle(
          "server-card",
          () =>
            runServerCardProbe(
              {
                serverUrl,
                snapshot: capture.snapshot,
                now,
                signal: httpController.signal,
                privateTarget,
              },
              { fetchFn: dependencies.fetchFn },
            ),
          httpDeadline.expired,
          now,
        ),
      ]);
    } finally {
      httpDeadline.clear();
    }
  })();

  const summaries = Promise.all([connectionProbes, httpProbes]).then(
    ([connection, http]) => {
      const byId = new Map<ServerProbeId, ProbeSummary>(
        [...connection, ...http].map((summary) => [summary.probeId, summary]),
      );
      return SERVER_PROBE_IDS.map(
        (id) => byId.get(id) ?? unranProbe(id, "failed", now(), THREW),
      );
    },
  );
  return {
    connectionBound: connectionProbes.then(() => undefined),
    summaries,
  };
}
