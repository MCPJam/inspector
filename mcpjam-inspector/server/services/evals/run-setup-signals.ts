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
 * Multi-server observation is race-free: callers must use a two-phase
 * `Promise.allSettled` barrier (all connects, then all tools-lists) so every
 * expected target is observed before `buildSignals`.
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
 * Hard-cap the producer-owned audit blob. Over the cap, drop span ids so
 * the serialized payload shrinks; `truncated: true` marks the shed.
 */
export function capSetupAuditMetadata(
  raw: {
    stageSetupSignals: StageSetupSignals;
    egressCanary: unknown;
  },
  capBytes: number = SETUP_SIGNALS_METADATA_CAP_BYTES
): Record<string, unknown> {
  const serialized = JSON.stringify(raw);
  if (serialized.length <= capBytes) return raw;
  const signals = raw.stageSetupSignals;
  return {
    stageSetupSignals: {
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

/**
 * Classify a connect / tools-list failure for D6 attribution.
 *
 *   ours   — DNS (`EgressResolutionError` / ENOTFOUND), blocked egress,
 *            401/403 (suite-credential config), MCP −32000/−32001
 *   theirs — refused / TLS / timeout-to-their-host / 5xx
 *   unknown — everything else
 *
 * Reuses hosted-egress-guard error types and the era-negotiation unwrap so a
 * wrapped transport failure is classified on the real cause.
 */
export function classifySetupAttribution(error: unknown): SetupAttribution {
  const cause = unwrapEraNegotiationCause(error);

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
  hasConnect: (serverId: string) => boolean;
  hasToolsList: (serverId: string) => boolean;
  connectOutcome: (serverId: string) => "ok" | "failed" | undefined;
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

    const attachCanary = (
      signal: StageSetupPhaseSignal | undefined
    ): StageSetupPhaseSignal | undefined => {
      if (!signal || signal.outcome !== "failed") return signal;
      if (signal.attribution !== "theirs") return signal;
      return {
        ...signal,
        egressVerified: canaryResult === true,
      };
    };

    return {
      ...(connection ? { connection: attachCanary(connection) } : {}),
      ...(discovery ? { discovery: attachCanary(discovery) } : {}),
    };
  };

  return {
    recordConnect: (serverId, init) => record(connects, serverId, init),
    recordToolsList: (serverId, init) => record(lists, serverId, init),
    hasConnect: (serverId) => connects.has(serverId),
    hasToolsList: (serverId) => lists.has(serverId),
    connectOutcome: (serverId) => connects.get(serverId)?.outcome,
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
      return capSetupAuditMetadata(
        {
          stageSetupSignals: signals,
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
      );
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
