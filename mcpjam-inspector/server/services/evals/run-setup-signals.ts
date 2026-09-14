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
  describeError,
  unwrapEraNegotiationCause,
  type BearerChallengeSummary,
  type NormalizedError,
} from "@mcpjam/sdk";
import type { StageSetupPhaseSignal, StageSetupSignals } from "@mcpjam/sdk/contract";
import { MAX_EVIDENCE_REASONS } from "@mcpjam/sdk/contract";
import type { ConnectionAuthContext } from "../connection-failure-context.js";
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
  /** What the failure was, in words and in fields. Present on a failure only. */
  detail?: SetupFailureDetail;
  startedAt: number;
  endedAt: number;
};

/**
 * What the producer knew about a server when its connect failed. All of it
 * optional: a manager built outside `createAuthorizedManager` (tests, the
 * replay helpers) enrols nothing, and the classifier then reads exactly as
 * it did before this context existed.
 */
export type SetupFailureContext = {
  /** How the server is named to the user; falls back to the server id. */
  serverLabel?: string;
  auth?: ConnectionAuthContext;
  challenge?: BearerChallengeSummary;
};

export type SetupRefreshOutcome =
  "token_rejected" | "authorization_server_unreachable";

/**
 * A failed connect or tools/list, explained.
 *
 * `line` is the one sentence a reader gets — on the stage row, in the run
 * error, in the API and the CLI. It is built from structured fields only
 * (status, the catalog slug, the parsed challenge, the server's display
 * name), never by interpolating a header or the raw transport message, so it
 * is safe to persist as-is. `normalized` is the catalog block for surfaces
 * that render an ErrorCard.
 */
export type SetupFailureDetail = {
  slug: string;
  attribution: SetupAttribution;
  line: string;
  status?: number;
  code?: string;
  refresh?: SetupRefreshOutcome;
  challenge?: BearerChallengeSummary;
  normalized: NormalizedError;
};

/** The audit copy of a detail: everything but the catalog block. */
export type SetupFailureRecord = {
  serverId: string;
  phase: SetupPhase;
  slug: string;
  attribution: SetupAttribution;
  line: string;
  status?: number;
  code?: string;
  refresh?: SetupRefreshOutcome;
  challenge?: BearerChallengeSummary;
};

/** Hard cap on a persisted reason line. */
export const MAX_SETUP_FAILURE_LINE_CHARS = 240;
/** Version of the classifier that produced the audit record. */
export const SETUP_FAILURE_CLASSIFIER_VERSION = 2;

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
/**
 * Raised from 2 KiB when the record started carrying per-server failure
 * lines. The shed below drops those FIRST, so the span ids the stage rows
 * reference are the last thing to go.
 */
const SETUP_SIGNALS_METADATA_CAP_BYTES = 4_096;
const MAX_AUDIT_FAILURES = 5;

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
    ...(signal.durationMs !== undefined
      ? { durationMs: signal.durationMs }
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
  /** Per-server failure explanations, bounded; the first thing shed. */
  failures?: SetupFailureRecord[];
  /** Which classifier wrote this record; absent means the pre-detail one. */
  classifier?: number;
  truncated?: true;
};

/**
 * Hard-cap the producer-owned audit blob. Over the cap, drop span ids so
 * the serialized payload shrinks; `truncated: true` marks the shed.
 */
export function capSetupAuditMetadata(
  raw: SetupAuditRecord,
  capBytes: number = SETUP_SIGNALS_METADATA_CAP_BYTES
): SetupAuditRecord {
  const serialized = JSON.stringify(raw);
  if (serialized.length <= capBytes) return raw;
  // Tier 1: keep the signals whole (span ids and reason lines are what the
  // stage rows reference) and drop the per-server explanations.
  if (raw.failures !== undefined) {
    const { failures: _failures, ...withoutFailures } = raw;
    if (JSON.stringify(withoutFailures).length <= capBytes) {
      return { ...withoutFailures, truncated: true };
    }
  }
  // Tier 2: the pre-detail shed — outcome, attribution, canary, duration.
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
    ...(raw.classifier !== undefined ? { classifier: raw.classifier } : {}),
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

function detailsOf(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object"
    ? (details as Record<string, unknown>)
    : undefined;
}

/**
 * A `WebRouteError` (or anything shaped like one), matched structurally so a
 * copy that crossed a module boundary still counts: numeric `status`, string
 * `code`. Every one of these on the setup path is thrown by OUR code before
 * or instead of contacting the server — the hosted refresh handler, the
 * tokenless-discover 401, the XAA mint — so none of them may ever be read as
 * the MCP server failing, whatever status they carry.
 */
function isControlPlaneError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
  };
  return (
    typeof candidate.status === "number" &&
    typeof candidate.code === "string" &&
    (candidate.name === "WebRouteError" ||
      candidate.name === "EvalSetupPhaseError" ||
      detailsOf(error) !== undefined)
  );
}

/**
 * What a hosted token refresh said, read off the typed details the refresh
 * handler attaches (`hosted-oauth-refresh.ts`). The 502 "Could not reach the
 * authorization server" from the local fallback carries no flag, so its
 * message is matched too — it is OUR sentence, not a server's.
 */
export function refreshOutcomeFromError(
  error: unknown,
): SetupRefreshOutcome | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const details = detailsOf(current);
    if (details?.authorizationServerUnreachable === true) {
      return "authorization_server_unreachable";
    }
    if (details?.refreshTokenInvalid === true) return "token_rejected";
    if (
      /^Could not reach the authorization server\b/.test(
        collectMessage(current),
      )
    ) {
      return "authorization_server_unreachable";
    }
    current =
      current && typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

function httpStatusOf(cause: unknown): number | undefined {
  return (
    numericField(cause, "statusCode") ??
    numericField(cause, "status") ??
    (typeof numericField(cause, "code") === "number" &&
    (numericField(cause, "code") as number) >= 100 &&
    (numericField(cause, "code") as number) <= 599
      ? numericField(cause, "code")
      : undefined)
  );
}

function clipLine(line: string): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SETUP_FAILURE_LINE_CHARS
    ? `${collapsed.slice(0, MAX_SETUP_FAILURE_LINE_CHARS - 1)}…`
    : collapsed;
}

/**
 * The one line a reader gets. Built from fields, never from the transport
 * message — except for the two cases whose message is already OUR authored
 * sentence (XAA connect failures, the tokenless-discover 401).
 */
function setupFailureLine(args: {
  label: string;
  slug: string;
  status?: number;
  refresh?: SetupRefreshOutcome;
  oauthRequired: boolean;
  xaaMessage?: string;
  auth?: ConnectionAuthContext;
  challenge?: BearerChallengeSummary;
  normalized: NormalizedError;
}): string {
  const { label, slug, challenge, auth } = args;
  const quoted = `"${label}"`;
  if (args.refresh === "authorization_server_unreachable") {
    return `MCPJam could not reach the authorization server to refresh the stored token for ${quoted}; the MCP server was not contacted.`;
  }
  if (
    args.refresh === "token_rejected" ||
    slug === "auth/oauth_refresh_failed"
  ) {
    return `The stored authorization for ${quoted} has expired or been revoked. Reconnect it in the server settings.`;
  }
  if (args.xaaMessage) return args.xaaMessage;
  if (args.oauthRequired) {
    return `${quoted} requires authorization and none is stored. Complete the OAuth flow, then re-run.`;
  }
  const reported = challenge?.error ? `, ${challenge.error}` : "";
  switch (slug) {
    case "oauth/no_bearer_challenge":
      return `${quoted} answered 401 without a Bearer challenge; MCP requires one, so its OAuth setup cannot be discovered. Run Doctor on this server.`;
    case "auth/insufficient_scope":
      return `${quoted} needs additional scopes${
        challenge?.scopes?.length ? ` (${challenge.scopes.join(" ")})` : ""
      }. Re-authorize with the required scopes.`;
    case "oauth/non_compliant_challenge":
      return `${quoted} answered 403 with a Bearer challenge where MCP requires 401. Re-authorize; report the status to the server author.`;
    case "auth/proxy_rejected":
      return `A proxy or firewall in front of ${quoted} rejected the request (HTTP 403). Check IP allowlists.`;
    case "auth/http_401":
      if (auth?.method === "bearer" || auth?.method === "none") {
        return `${quoted} rejected the configured Authorization header (HTTP 401${reported}).`;
      }
      if (auth && !auth.credentialSent) {
        return `${quoted} requires authorization (HTTP 401${reported}) and none is stored. Complete the OAuth flow, then re-run.`;
      }
      return `${quoted} rejected the stored token (HTTP 401${reported}). Re-authorize the server.`;
    case "auth/http_403":
      return `${quoted} refused the credential (HTTP 403${reported}).`;
    default: {
      const statusNote =
        args.status !== undefined && !/\b\d{3}\b/.test(args.normalized.oneLine)
          ? ` (HTTP ${args.status})`
          : "";
      return `${quoted}: ${args.normalized.oneLine}${statusNote}`;
    }
  }
}

/**
 * Explain a connect / tools-list failure: attribution for the chain, a
 * catalog slug and block for cards, one line for people.
 *
 * Attribution is decided here, not read off the catalog origin: the catalog
 * answers "who must act", D6 answers "did we reach their host", and
 * `ECONNREFUSED` answers those two questions differently. The table:
 *
 *   - a control-plane error (refresh handler, XAA mint, tokenless-discover
 *     401) ⇒ ours, whatever status it carries — the server was never the
 *     thing that failed;
 *   - otherwise the transport classification (`classifySetupAttribution`),
 *     with two challenge-informed corrections on a 401/403 that would have
 *     been `ours`: a 401 with NO Bearer challenge from a server configured
 *     for OAuth discovery, and a 403 that is an HTML page with no challenge,
 *     become `unknown` — we cannot show the server refused a valid
 *     credential, and we also cannot call the failure ours.
 */
export function describeSetupFailure(
  error: unknown,
  ctx?: SetupFailureContext & { serverId?: string },
): SetupFailureDetail {
  const cause = unwrapEraNegotiationCause(error);
  const refresh = refreshOutcomeFromError(error);
  const controlPlane = isControlPlaneError(error) || isControlPlaneError(cause);
  const details = detailsOf(error) ?? detailsOf(cause);
  const oauthRequired =
    details?.oauthRequired === true && details?.refreshTokenInvalid !== true;
  const xaaMessage =
    typeof details?.reason === "string" && controlPlane
      ? collectMessage(error)
      : undefined;
  const status = httpStatusOf(cause) ?? httpStatusOf(error);
  // A server configured with a static header, or none, is not expected to
  // challenge: its 401 without `WWW-Authenticate` is a wrong header, not a
  // discovery gap, so the challenge is withheld from the describer for it.
  const expectsOAuth =
    ctx?.auth === undefined ||
    ctx.auth.method === "oauth" ||
    ctx.auth.method === "discover";
  const challenge =
    ctx?.challenge &&
    (expectsOAuth || status !== 401 || ctx.challenge.scheme !== "none")
      ? ctx.challenge
      : undefined;
  const normalized = describeError(cause, {
    surface: "mcpServer",
    // Always the user's for the capture decision: a customer's revoked token
    // or an authorization server they operate must never page us.
    credentialOwner: "user",
    ...(challenge ? { challenge } : {}),
    ...(refresh ? { refresh: { outcome: refresh } } : {}),
  });
  const slug = oauthRequired ? "auth/http_401" : normalized.slug;

  let attribution: SetupAttribution;
  if (controlPlane || refresh !== undefined) {
    attribution = "ours";
  } else {
    attribution = classifySetupAttribution(error);
    if (attribution === "ours" && challenge && status !== undefined) {
      if (status === 401 && challenge.scheme === "none" && expectsOAuth) {
        attribution = "unknown";
      } else if (
        status === 403 &&
        challenge.scheme === "none" &&
        challenge.bodyKind === "html"
      ) {
        attribution = "unknown";
      }
    }
  }

  const code =
    typeof normalized.rawCode === "string" ? normalized.rawCode : undefined;
  const line = clipLine(
    setupFailureLine({
      label: ctx?.serverLabel ?? ctx?.serverId ?? "the server",
      slug,
      status,
      refresh,
      oauthRequired,
      xaaMessage,
      auth: ctx?.auth,
      challenge: ctx?.challenge,
      normalized,
    }),
  );
  return {
    slug,
    attribution,
    line,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(refresh ? { refresh } : {}),
    ...(ctx?.challenge ? { challenge: ctx.challenge } : {}),
    normalized,
  };
}

/**
 * Classify a connect / tools-list failure for D6 attribution.
 *
 *   ours   — our own cancellation, a control-plane error (refresh handler,
 *            XAA mint, tokenless-discover 401 — whatever status it carries),
 *            DNS (`EgressResolutionError` / ENOTFOUND), blocked egress,
 *            401/403 (suite-credential config), MCP −32000/−32001
 *   theirs — refused / TLS / timeout-to-their-host / 5xx FROM THE TARGET
 *   unknown — everything else
 *
 * Reuses hosted-egress-guard error types and the era-negotiation unwrap so a
 * wrapped transport failure is classified on the real cause. The
 * challenge-informed corrections live in `describeSetupFailure`, which is
 * what the observer calls; this function alone reads exactly as it did.
 */
export function classifySetupAttribution(error: unknown): SetupAttribution {
  const cause = unwrapEraNegotiationCause(error);

  // Before every transport heuristic: a cancelled run says nothing about
  // the target server.
  if (isCancellation(error, cause)) return "ours";

  // A control-plane failure never reached the target. Ahead of the status
  // arms because the refresh handler's 503 "authorization server
  // unreachable" would otherwise read as their 5xx.
  if (
    isControlPlaneError(error) ||
    isControlPlaneError(cause) ||
    refreshOutcomeFromError(error) !== undefined
  ) {
    return "ours";
  }

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

/**
 * One line per failing server, de-duplicated, in expected-server order, under
 * the analyzer's cap. The deciding attribution's line comes first so a mixed
 * bag reads with the failure that set the phase's state on top.
 */
function foldReasons(failures: readonly SetupTargetObservation[]): string[] {
  const folded = foldAttribution(failures);
  const ordered = [
    ...failures.filter((row) => row.attribution === folded),
    ...failures.filter((row) => row.attribution !== folded),
  ];
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const row of ordered) {
    const line = row.detail?.line;
    if (!line || seen.has(line)) continue;
    seen.add(line);
    reasons.push(line);
    if (reasons.length >= MAX_EVIDENCE_REASONS) break;
  }
  return reasons;
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

  // Setup phases are measured once per run using the wall-clock envelope over
  // settled targets. Never emit a duration for the incomplete-observation
  // branch above: its envelope would claim a phase finished while a target was
  // still outstanding.
  const phaseDurationMs = (): number | undefined => {
    if (
      !observed.every(
        (row) =>
          Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt)
      )
    ) {
      return undefined;
    }
    // A wall-clock timestamp can move backwards (or a caller can provide a
    // malformed interval). One inverted target poisons the envelope: using a
    // different valid target to produce a duration would claim a phase was
    // measured when part of its evidence is contradictory.
    if (observed.some((row) => row.endedAt < row.startedAt)) {
      return undefined;
    }
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const row of observed) {
      if (row.startedAt < start) start = row.startedAt;
      if (row.endedAt > end) end = row.endedAt;
    }
    const duration = end - start;
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
  };

  if (failures.length > 0) {
    const durationMs = phaseDurationMs();
    const reasons = foldReasons(failures);
    return {
      outcome: "failed",
      attribution: foldAttribution(failures),
      spanIds: failures
        .map((row) => spanIdFor(row.serverId))
        .slice(0, MAX_CULPRIT_SPAN_IDS),
      ...(reasons.length > 0 ? { reasons } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (observed.every((row) => row.outcome === "ok")) {
    const durationMs = phaseDurationMs();
    return { outcome: "ok", ...(durationMs !== undefined ? { durationMs } : {}) };
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
  /** The explanation recorded for one server's phase, if it failed. */
  failureDetail: (
    serverId: string,
    phase: SetupPhase,
  ) => SetupFailureDetail | undefined;
  /** Every recorded failure, audit-shaped and bounded. */
  buildFailureRecords: () => SetupFailureRecord[];
};

export type CreateRunSetupObserverOptions = {
  expectedServerIds: readonly string[];
  convexHttpUrl?: string;
  /** Injected canary. Tests stub this so we never touch the control plane. */
  canary?: () => Promise<boolean>;
  now?: () => number;
  /**
   * What the producer knows about a server, read at failure time. Absent
   * (or returning nothing) ⇒ the failure is explained from the error alone.
   */
  context?: (serverId: string) => SetupFailureContext | undefined;
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
    const detail =
      init.outcome === "failed"
        ? describeSetupFailure(init.error, {
            serverId,
            ...(options.context?.(serverId) ?? {}),
          })
        : undefined;
    into.set(serverId, {
      serverId,
      outcome: init.outcome,
      ...(detail ? { attribution: detail.attribution, detail } : {}),
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

  const failureRecords = (): SetupFailureRecord[] => {
    const records: SetupFailureRecord[] = [];
    for (const [phase, map] of [
      ["connection", connects],
      ["discovery", lists],
    ] as const) {
      for (const serverId of expected) {
        const row = map.get(serverId);
        if (!row?.detail) continue;
        const { normalized: _normalized, ...rest } = row.detail;
        records.push({ serverId, phase, ...rest });
        if (records.length >= MAX_AUDIT_FAILURES) return records;
      }
    }
    return records;
  };

  return {
    recordConnect: (serverId, init) => record(connects, serverId, init),
    recordToolsList: (serverId, init) => record(lists, serverId, init),
    ensureEgressCanary,
    buildSignals,
    failureDetail: (serverId, phase) =>
      (phase === "connection" ? connects : lists).get(serverId)?.detail,
    buildFailureRecords: failureRecords,
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
      const failures = failureRecords();
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
            // Only a record with something to explain names its classifier,
            // so a clean run's audit stays byte-identical to the pre-detail one.
            ...(failures.length > 0
              ? { failures, classifier: SETUP_FAILURE_CLASSIFIER_VERSION }
              : {}),
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
