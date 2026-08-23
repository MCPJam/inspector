/**
 * Run-level connect / tools-list observation for D6.
 *
 * Connect and tools-list happen once per run, above the iteration boundary
 * where no span sink exists. This observer records every expected target,
 * folds them deterministically, and emits:
 *
 *   - `StageSetupSignals` — the derivation input (never spans)
 *   - synthetic `connection` / `discovery` spans — persistence/timeline only
 *
 * Multi-server observation is race-free: the caller must settle EVERY
 * expected target (`Promise.allSettled`, which unlike `Promise.all` does not
 * abort in-flight siblings) before calling `buildSignals`. Folding while one
 * server's connect is still open would let a discovery failure decide the
 * chain ahead of a connection failure that had not landed yet.
 *
 * Connect and tools/list are observed from ONE `getToolsForAiSdk` call per
 * server — it ensures the session and lists in a single round trip, so
 * probing them separately would bill the customer's server twice.
 */

import {
  classifyNegotiationFailureClass,
  unwrapEraNegotiationCause,
} from "@mcpjam/sdk";
import type { StageSetupPhaseSignal, StageSetupSignals } from "@mcpjam/sdk/contract";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { HOSTED_MODE } from "../../config.js";
import { createPinnedFetch } from "../../utils/pinned-fetch.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../../utils/hosted-egress-guard.js";

export type SetupAttribution = "ours" | "theirs" | "unknown";
export type SetupPhase = "connection" | "discovery";

export type SetupTargetObservation = {
  serverId: string;
  outcome: "ok" | "failed";
  attribution?: SetupAttribution;
  error?: unknown;
  startedAt: number;
  endedAt: number;
};

const TRANSPORT_LOCAL_MCP_CODES = new Set([-32000, -32001]);
const OURS_NODE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NODATA",
  "EAI_NONAME",
]);
const THEIRS_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const MAX_CULPRIT_SPAN_IDS = 5;
const CANARY_TIMEOUT_MS = 5_000;
const SETUP_SIGNALS_METADATA_CAP_BYTES = 2_048;

function slimPhaseSignal(
  signal: StageSetupPhaseSignal | undefined
): StageSetupPhaseSignal | undefined {
  if (!signal) return undefined;
  return {
    outcome: signal.outcome,
    ...(signal.attribution ? { attribution: signal.attribution } : {}),
    ...(signal.egressVerified !== undefined
      ? { egressVerified: signal.egressVerified }
      : {}),
  };
}

/**
 * The ONE metadata key this module owns.
 *
 * Everything the audit record carries nests under it. Iteration metadata is
 * a flat open record shared by every producer, so a bare `truncated` (or
 * `egressCanary`) at top level is a name collision waiting for the next
 * writer that wants the same generic word.
 */
export const SETUP_AUDIT_METADATA_KEY = "stageSetupAudit";

export type SetupAuditRecord = {
  signals: StageSetupSignals;
  egressCanary: unknown;
  truncated?: true;
};

/**
 * Hard-cap the producer-owned audit blob. Over the cap, drop span ids so
 * the serialized payload shrinks; `truncated: true` marks the shed.
 */
export function capSetupAuditMetadata(
  raw: {
    signals: StageSetupSignals;
    egressCanary: unknown;
  },
  capBytes: number = SETUP_SIGNALS_METADATA_CAP_BYTES
): SetupAuditRecord {
  const serialized = JSON.stringify(raw);
  if (serialized.length <= capBytes) return raw;
  const signals = raw.signals;
  return {
    signals: {
      ...(signals.connection
        ? { connection: slimPhaseSignal(signals.connection) }
        : {}),
      ...(signals.discovery
        ? { discovery: slimPhaseSignal(signals.discovery) }
        : {}),
    },
    egressCanary: raw.egressCanary,
    truncated: true,
  };
}

export function connectSpanId(serverId: string): string {
  return `run-connect-${serverId}`;
}

export function toolsListSpanId(serverId: string): string {
  return `run-toolslist-${serverId}`;
}

function numericField(error: unknown, key: string): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function stringField(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function collectMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

const CANCELLATION_ERROR_NAMES = new Set(["AbortError", "CanceledError"]);
const CANCELLATION_CODES = new Set([
  "ABORT_ERR",
  "ERR_CANCELED",
  "ERR_CANCELLED",
]);

/**
 * True when the failure is OUR cancellation — the caller aborted, the run
 * was stopped, the deadline fired — rather than anything the target did.
 *
 * Matched structurally (error `name` / `code`) and, only as a fallback, on
 * phrases that cannot appear in a transport error. A loose `/abort/i` on
 * the message would swallow `ECONNABORTED`, which is a real peer-side reset
 * and belongs to `theirs`; that is why this never tests the bare word.
 *
 * Without this arm a cancelled run classifies `unknown`, and an `unknown`
 * tools/list failure on a server whose initialize completed derives
 * `discovery: failed` — reporting a user pressing stop as the server's
 * fault, which is exactly the confidently-wrong funnel top D6 exists to
 * prevent.
 */
function isCancellation(error: unknown, cause: unknown): boolean {
  for (const candidate of [cause, error]) {
    const name = stringField(candidate, "name");
    if (name && CANCELLATION_ERROR_NAMES.has(name)) return true;
    const code = stringField(candidate, "code");
    if (code && CANCELLATION_CODES.has(code)) return true;
  }
  const message = `${collectMessage(cause)} ${collectMessage(error)}`;
  return /\boperation was aborted\b|\brequest (?:was )?(?:aborted|cancell?ed)\b|\baborted by (?:the )?(?:user|caller)\b|\bthe user aborted a request\b/i.test(
    message
  );
}

/**
 * Classify a connect / tools-list failure for D6 attribution.
 *
 *   ours   — our own cancellation, DNS (`EgressResolutionError` /
 *            ENOTFOUND), blocked egress, 401/403 (suite-credential
 *            config), MCP −32000/−32001
 *   theirs — refused / TLS / timeout-to-their-host / 5xx
 *   unknown — everything else
 *
 * Reuses hosted-egress-guard error types and the era-negotiation unwrap so a
 * wrapped transport failure is classified on the real cause.
 */
export function classifySetupAttribution(error: unknown): SetupAttribution {
  const cause = unwrapEraNegotiationCause(error);

  // Before every transport heuristic: a cancelled run says nothing about
  // the target server.
  if (isCancellation(error, cause)) return "ours";

  if (cause instanceof EgressResolutionError) return "ours";
  if (cause instanceof BlockedEgressTargetError) return "ours";

  const status =
    numericField(cause, "statusCode") ??
    numericField(cause, "status") ??
    (typeof numericField(cause, "code") === "number" &&
    (numericField(cause, "code") as number) >= 100 &&
    (numericField(cause, "code") as number) <= 599
      ? numericField(cause, "code")
      : undefined);

  if (status === 401 || status === 403) return "ours";
  if (status !== undefined && status >= 500) return "theirs";

  const mcpCode =
    numericField(cause, "mcpErrorCode") ??
    (typeof numericField(cause, "code") === "number" &&
    (numericField(cause, "code") as number) < 0
      ? numericField(cause, "code")
      : undefined);
  if (mcpCode !== undefined && TRANSPORT_LOCAL_MCP_CODES.has(mcpCode)) {
    return "ours";
  }

  const nodeCode =
    stringField(cause, "code") ??
    (typeof numericField(cause, "code") === "number"
      ? undefined
      : stringField(error, "code"));
  if (nodeCode && OURS_NODE_CODES.has(nodeCode)) return "ours";
  if (nodeCode && THEIRS_NODE_CODES.has(nodeCode)) return "theirs";

  const klass = classifyNegotiationFailureClass(cause);
  if (klass === "UnauthorizedError" || klass === "401" || klass === "403") {
    return "ours";
  }
  if (OURS_NODE_CODES.has(klass)) return "ours";
  if (THEIRS_NODE_CODES.has(klass)) return "theirs";

  const message = `${klass} ${collectMessage(cause)} ${collectMessage(error)}`;
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) return "ours";
  if (
    /ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(
      message
    )
  ) {
    return "theirs";
  }
  if (/certificate|CERT_|UNABLE_TO_VERIFY|SSL|TLS|ERR_TLS/i.test(message)) {
    return "theirs";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "ours";
  if (/\b5\d\d\b/.test(message) && /status|http|server/i.test(message)) {
    return "theirs";
  }

  return "unknown";
}

function foldAttribution(
  failures: readonly SetupTargetObservation[]
): SetupAttribution {
  if (failures.some((f) => f.attribution === "ours")) return "ours";
  if (failures.some((f) => f.attribution === "unknown" || !f.attribution)) {
    return "unknown";
  }
  return "theirs";
}

function foldPhase(
  expectedIds: readonly string[],
  observations: ReadonlyMap<string, SetupTargetObservation>,
  spanIdFor: (serverId: string) => string
): StageSetupPhaseSignal | undefined {
  if (expectedIds.length === 0) return undefined;

  const observed: SetupTargetObservation[] = [];
  const missing: string[] = [];
  for (const id of expectedIds) {
    const row = observations.get(id);
    if (!row) missing.push(id);
    else observed.push(row);
  }

  // The phase never ran for ANY target — connect failed everywhere, so
  // tools/list was never attempted. That is an absence of evidence, not a
  // failed tools/list: emit no signal and let the stage fall through to
  // `notReached` behind the connection failure. Folding it as `failed`
  // would put a discovery verdict on a phase that never executed.
  if (observed.length === 0) return undefined;

  const failures = observed.filter((row) => row.outcome === "failed");
  // A target that never settled is an incomplete observation → unknown.
  if (missing.length > 0) {
    return {
      outcome: "failed",
      attribution: foldAttribution([
        ...failures,
        ...missing.map((serverId) => ({
          serverId,
          outcome: "failed" as const,
          attribution: "unknown" as const,
          startedAt: 0,
          endedAt: 0,
        })),
      ]),
      spanIds: [...failures, ...missing.map((id) => ({ serverId: id }))]
        .map((row) => spanIdFor(row.serverId))
        .slice(0, MAX_CULPRIT_SPAN_IDS),
    };
  }

  if (failures.length > 0) {
    return {
      outcome: "failed",
      attribution: foldAttribution(failures),
      spanIds: failures
        .map((row) => spanIdFor(row.serverId))
        .slice(0, MAX_CULPRIT_SPAN_IDS),
    };
  }

  if (observed.every((row) => row.outcome === "ok")) {
    return { outcome: "ok" };
  }

  return {
    outcome: "failed",
    attribution: "unknown",
  };
}

export type RunSetupObserver = {
  recordConnect: (
    serverId: string,
    init: {
      outcome: "ok" | "failed";
      error?: unknown;
      startedAt: number;
      endedAt: number;
    }
  ) => void;
  recordToolsList: (
    serverId: string,
    init: {
      outcome: "ok" | "failed";
      error?: unknown;
      startedAt: number;
      endedAt: number;
    }
  ) => void;
  /**
   * Lazy, once per run, only on a theirs-shaped failure. Never called for
   * `ours`. Returns whether `GET ${convexHttpUrl}/health` succeeded.
   */
  ensureEgressCanary: () => Promise<boolean>;
  buildSignals: () => StageSetupSignals | undefined;
  buildSyntheticSpans: (runStartedAt: number) => EvalTraceSpan[];
  /**
   * Bounded producer-owned audit record. Open metadata; the backend ignores
   * it. Hard-capped so a v2 verdict can be recomputed without an unbounded blob.
   */
  buildAuditMetadata: () => Record<string, unknown> | undefined;
};

export type CreateRunSetupObserverOptions = {
  expectedServerIds: readonly string[];
  convexHttpUrl?: string;
  /** Injected canary. Tests stub this so we never touch the control plane. */
  canary?: () => Promise<boolean>;
  now?: () => number;
};

async function defaultCanary(convexHttpUrl: string): Promise<boolean> {
  const pinned = createPinnedFetch({
    timeoutMs: CANARY_TIMEOUT_MS,
    allowLoopback: !HOSTED_MODE,
  });
  const url = `${convexHttpUrl.replace(/\/+$/, "")}/health`;
  const response = await pinned(url);
  return response.ok;
}

export function createRunSetupObserver(
  options: CreateRunSetupObserverOptions
): RunSetupObserver {
  const expected = [...options.expectedServerIds];
  const connects = new Map<string, SetupTargetObservation>();
  const lists = new Map<string, SetupTargetObservation>();
  let canaryResult: boolean | undefined;
  let canaryPromise: Promise<boolean> | undefined;

  const record = (
    into: Map<string, SetupTargetObservation>,
    serverId: string,
    init: {
      outcome: "ok" | "failed";
      error?: unknown;
      startedAt: number;
      endedAt: number;
    }
  ) => {
    const attribution =
      init.outcome === "failed"
        ? classifySetupAttribution(init.error)
        : undefined;
    into.set(serverId, {
      serverId,
      outcome: init.outcome,
      ...(attribution ? { attribution } : {}),
      ...(init.error !== undefined ? { error: init.error } : {}),
      startedAt: init.startedAt,
      endedAt: init.endedAt,
    });
  };

  const ensureEgressCanary = async (): Promise<boolean> => {
    if (canaryResult !== undefined) return canaryResult;
    canaryPromise ??= (async () => {
      try {
        if (options.canary) return await options.canary();
        if (options.convexHttpUrl) return await defaultCanary(options.convexHttpUrl);
        return false;
      } catch {
        return false;
      }
    })();
    canaryResult = await canaryPromise;
    return canaryResult;
  };

  const buildSignals = (): StageSetupSignals | undefined => {
    if (expected.length === 0) return undefined;
    const connection = foldPhase(expected, connects, connectSpanId);
    const discovery = foldPhase(expected, lists, toolsListSpanId);
    if (!connection && !discovery) return undefined;

    // Canary is connection-only. A completed initialize is the egress
    // evidence for discovery; stamping a failed control-plane GET onto a
    // tools/list miss would lie about whether we reached their host.
    const attachConnectionCanary = (
      signal: StageSetupPhaseSignal | undefined
    ): StageSetupPhaseSignal | undefined => {
      if (!signal || signal.outcome !== "failed") return signal;
      if (signal.attribution !== "theirs") return signal;
      // Absent when the canary never ran: "we did not check" and "we
      // checked and our egress is down" are different states, and only
      // `true` may ever earn `connection: failed`.
      if (canaryResult === undefined) return signal;
      return {
        ...signal,
        egressVerified: canaryResult,
      };
    };

    return {
      ...(connection ? { connection: attachConnectionCanary(connection) } : {}),
      ...(discovery ? { discovery } : {}),
    };
  };

  return {
    recordConnect: (serverId, init) => record(connects, serverId, init),
    recordToolsList: (serverId, init) => record(lists, serverId, init),
    ensureEgressCanary,
    buildSignals,
    buildSyntheticSpans: (runStartedAt) =>
      buildSyntheticSetupSpans({
        expected,
        connects,
        lists,
        runStartedAt,
      }),
    buildAuditMetadata: () => {
      const signals = buildSignals();
      if (!signals) return undefined;
      return {
        [SETUP_AUDIT_METADATA_KEY]: capSetupAuditMetadata(
          {
            signals,
            egressCanary:
              canaryResult === undefined
                ? { ran: false }
                : {
                    ran: true,
                    ok: canaryResult,
                    at: (options.now ?? Date.now)(),
                  },
          },
          SETUP_SIGNALS_METADATA_CAP_BYTES
        ),
      };
    },
  };
}

function clampSpanToOffsetZero(
  startedAt: number,
  endedAt: number
): { startMs: number; endMs: number } {
  const duration = Math.max(1, endedAt - startedAt);
  return { startMs: 0, endMs: duration };
}

function buildSyntheticSetupSpans(args: {
  expected: readonly string[];
  connects: ReadonlyMap<string, SetupTargetObservation>;
  lists: ReadonlyMap<string, SetupTargetObservation>;
  runStartedAt: number;
}): EvalTraceSpan[] {
  const spans: EvalTraceSpan[] = [];
  for (const serverId of args.expected) {
    const connect = args.connects.get(serverId);
    if (connect) {
      spans.push({
        id: connectSpanId(serverId),
        name: "connect",
        category: "connection",
        status: connect.outcome === "ok" ? "ok" : "error",
        serverId,
        ...clampSpanToOffsetZero(connect.startedAt, connect.endedAt),
      });
    }
    const list = args.lists.get(serverId);
    if (list) {
      spans.push({
        id: toolsListSpanId(serverId),
        name: "tools/list",
        category: "discovery",
        status: list.outcome === "ok" ? "ok" : "error",
        serverId,
        ...clampSpanToOffsetZero(list.startedAt, list.endedAt),
      });
    }
  }
  void args.runStartedAt;
  return spans;
}

export function isTheirsAttribution(
  attribution: SetupAttribution | undefined
): boolean {
  return attribution === "theirs";
}
