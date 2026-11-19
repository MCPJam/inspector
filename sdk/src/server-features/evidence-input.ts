/**
 * Stored evidence (backend `serverFeatureEvidence:getForServer`) → evaluator
 * input for ONE capture context. Evidence from different contexts (account,
 * client, environment, protocol version) is never merged; the page picks a
 * context, defaulting to the latest capture's.
 */

import { toDeclaredSurface } from "./declared-surface.js";
import { normalizeCaptureTransport } from "./context.js";
import { isConformanceCheckRef } from "./check-evidence.js";
import {
  SERVER_PROBE_IDS,
  type CaptureContext,
  type CheckResultEvidence,
  type CheckStatus,
  type ConformanceCheckRef,
  type ConformanceSuiteKey,
  type FeatureObservation,
  type FeatureSetupKind,
  type OAuthFlowSummary,
  type ProbeScalar,
  type ProbeStatus,
  type ProbeSummary,
  type ProbeValue,
  type ProbeSurface,
  type ServerFeatureEvidenceInput,
  type ServerProbeId,
} from "./types.js";

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface StoredServerEvidence {
  inspection?: unknown;
  probeResults?: unknown;
  observations?: unknown;
}

export interface EvidenceContextOption {
  contextHash: string;
  context?: CaptureContext;
  /** Newest time any evidence was recorded under this context. */
  updatedAt?: number;
}

export interface ProbeFailure {
  probeId: ServerProbeId;
  status: ProbeStatus;
  at: number;
  detail?: string;
}

export interface CaptureAttempt {
  status: "ok" | "partial" | "failed";
  at: number;
  error?: string;
}

export interface SelectedServerEvidence {
  input: ServerFeatureEvidenceInput;
  contextHash?: string;
  /** Capture time of the declared snapshot shown, if any. */
  capturedAt?: number;
  /**
   * Newest failed capture attempt, shown beside the last good evidence. With
   * no saved capture to show, a failed probe run of the selected context
   * stands in, so a server whose first capture failed still says so.
   */
  latestAttempt?: CaptureAttempt;
  probeFailures: readonly ProbeFailure[];
  contexts: readonly EvidenceContextOption[];
}

export function parseCaptureContext(value: unknown): CaptureContext | undefined {
  if (!isRecord(value)) return undefined;
  const era = value.era;
  const context: CaptureContext = {
    transport: normalizeCaptureTransport(value.transport),
  };
  if (era === "legacy" || era === "modern" || era === "unknown") context.era = era;
  for (const key of [
    "protocolVersion",
    "clientCapabilitiesHash",
    "hostProfile",
    "environmentId",
    "accountBinding",
    "configRevision",
  ] as const) {
    const text = str(value[key]);
    if (text) context[key] = text;
  }
  if (Array.isArray(value.clientExtensions)) {
    context.clientExtensions = value.clientExtensions.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return context;
}

function isProbeId(value: unknown): value is ServerProbeId {
  return (
    typeof value === "string" &&
    (SERVER_PROBE_IDS as readonly string[]).includes(value)
  );
}

function isProbeStatus(value: unknown): value is ProbeStatus {
  return (
    value === "ok" ||
    value === "failed" ||
    value === "skipped" ||
    value === "not-applicable" ||
    value === "abandoned"
  );
}

function isScalar(value: unknown): value is ProbeScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function probeValues(value: unknown): Record<string, ProbeValue> {
  const out: Record<string, ProbeValue> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (isScalar(entry)) out[key] = entry;
    else if (Array.isArray(entry) && entry.every(isScalar)) out[key] = entry;
  }
  return out;
}

function probeChecks(
  value: unknown,
): Partial<Record<ConformanceCheckRef, CheckStatus>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<ConformanceCheckRef, CheckStatus>> = {};
  for (const [ref, status] of Object.entries(value)) {
    if (!isConformanceCheckRef(ref)) continue;
    if (status === "passed" || status === "failed" || status === "skipped" || status === "warned")
      out[ref] = status;
  }
  return out;
}

function parseProbe(value: Rec): ProbeSummary | undefined {
  const at = num(value.at);
  if (!isProbeId(value.probeId) || !isProbeStatus(value.status) || at === undefined)
    return undefined;
  const coverage = value.coverage;
  return {
    probeId: value.probeId,
    status: value.status,
    coverage:
      coverage === "complete" || coverage === "partial" ? coverage : "not-captured",
    at,
    detail: str(value.detail),
    // Keys were written by the probe runner against `ProbeValueKeysMap`;
    // unknown keys are harmless because rules only read the keys they know.
    values: probeValues(value.values),
    checks: probeChecks(value.checks),
  };
}

function parseOAuthFlow(value: unknown): OAuthFlowSummary | undefined {
  if (!isRecord(value)) return undefined;
  const completedAt = num(value.completedAt);
  if (completedAt === undefined) return undefined;
  const list = (entry: unknown) =>
    Array.isArray(entry)
      ? entry.filter((item): item is string => typeof item === "string")
      : [];
  const strategy = value.registrationStrategy;
  return {
    completedAt,
    issuer: str(value.issuer),
    protocolVersion: str(value.protocolVersion),
    registrationStrategy:
      strategy === "preregistered" || strategy === "dcr" || strategy === "cimd"
        ? strategy
        : undefined,
    resourceIndicatorSent: value.resourceIndicatorSent === true,
    scopesRequested: list(value.scopesRequested),
    scopesGranted: list(value.scopesGranted),
    issReturned: value.issReturned === true,
    issValidated: value.issValidated === true,
    refreshTokenIssued: value.refreshTokenIssued === true,
    tokenEndpointAuthMethod: str(value.tokenEndpointAuthMethod),
  };
}

function parseObservation(value: Rec): FeatureObservation | undefined {
  const featureId = str(value.featureId);
  const count = num(value.count);
  const firstSeenAt = num(value.firstSeenAt);
  const lastSeenAt = num(value.lastSeenAt);
  if (!featureId || count === undefined || firstSeenAt === undefined || lastSeenAt === undefined)
    return undefined;
  return {
    featureId,
    count,
    firstSeenAt,
    lastSeenAt,
    lastSource: value.lastSource === "apps-bridge" ? "apps-bridge" : "rpc",
  };
}

/**
 * A probe run that failed outright or stopped early, read from a probe row's
 * `lastAttempt*` fields. The Inspector sets the error to a fixed code such as
 * `capture_failed` when the capture before the probes failed; `list_failed`
 * means a list did not complete, so the capture was partial.
 */
function probeRunAttempt(row: Rec | undefined): CaptureAttempt | undefined {
  const at = num(row?.lastAttemptAt);
  const error = str(row?.lastAttemptError);
  if (at === undefined) return undefined;
  if (error === undefined && row?.lastAttemptStatus !== "failed") return undefined;
  return { status: error === "list_failed" ? "partial" : "failed", at, error };
}

/** Every context that has evidence, newest first. */
export function listEvidenceContexts(
  stored: StoredServerEvidence,
): EvidenceContextOption[] {
  const byHash = new Map<string, EvidenceContextOption>();
  const note = (hash: string | undefined, context: unknown, at: number | undefined) => {
    if (!hash) return;
    const existing = byHash.get(hash);
    const parsed = parseCaptureContext(context);
    byHash.set(hash, {
      contextHash: hash,
      context: existing?.context ?? parsed,
      updatedAt: Math.max(existing?.updatedAt ?? 0, at ?? 0) || undefined,
    });
  };
  const inspection = isRecord(stored.inspection) ? stored.inspection : undefined;
  note(
    str(inspection?.latestCaptureContextHash),
    inspection?.latestCaptureContext,
    num(inspection?.latestCapturedAt),
  );
  for (const row of records(stored.probeResults)) {
    note(str(row.contextHash), row.captureContext, num(row.updatedAt));
  }
  for (const row of records(stored.observations)) {
    note(str(row.contextHash), undefined, num(row.lastSeenAt));
  }
  return [...byHash.values()].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
}

export function selectServerEvidence(
  stored: StoredServerEvidence,
  options: {
    connected: boolean;
    contextHash?: string;
    checks?: readonly CheckResultEvidence[];
    configured?: readonly FeatureSetupKind[];
    setupOffered?: readonly FeatureSetupKind[];
    checksOffered?: readonly ConformanceSuiteKey[];
  },
): SelectedServerEvidence {
  const contexts = listEvidenceContexts(stored);
  const inspection = isRecord(stored.inspection) ? stored.inspection : undefined;
  const inspectionHash = str(inspection?.latestCaptureContextHash);
  const contextHash = options.contextHash ?? inspectionHash ?? contexts[0]?.contextHash;
  const context = contexts.find((option) => option.contextHash === contextHash)?.context;

  // A legacy inspection has no context; show it only when nothing else is known.
  const useInspection =
    inspection !== undefined &&
    (inspectionHash ? inspectionHash === contextHash : contextHash === undefined);
  const surface = useInspection
    ? toDeclaredSurface({
        snapshot: inspection.snapshot,
        envelopeVersion: num(inspection.latestEnvelopeVersion),
        redaction: inspection.redaction,
      })
    : undefined;
  const capturedAt = useInspection ? num(inspection?.latestCapturedAt) : undefined;

  const probeRow = records(stored.probeResults).find(
    (row) => str(row.contextHash) === contextHash,
  );
  const probes: Partial<Record<ServerProbeId, ProbeSummary>> = {};
  for (const entry of records(probeRow?.probes)) {
    const summary = parseProbe(entry);
    if (summary) probes[summary.probeId] = summary;
  }
  const probeFailures: ProbeFailure[] = [];
  for (const entry of records(probeRow?.failures)) {
    const at = num(entry.at);
    if (isProbeId(entry.probeId) && isProbeStatus(entry.status) && at !== undefined)
      probeFailures.push({ probeId: entry.probeId, status: entry.status, at, detail: str(entry.detail) });
  }
  const observations = records(stored.observations)
    .filter((row) => str(row.contextHash) === contextHash)
    .map(parseObservation)
    .filter((entry): entry is FeatureObservation => entry !== undefined);

  const attempt = isRecord(inspection?.latestAttempt) ? inspection.latestAttempt : undefined;
  const attemptAt = num(attempt?.at);
  const inspectionAttempt: CaptureAttempt | undefined =
    attempt && attemptAt !== undefined && (attempt.status === "partial" || attempt.status === "failed")
      ? { status: attempt.status, at: attemptAt, error: str(attempt.error) }
      : undefined;
  const latestAttempt =
    inspectionAttempt ?? (surface === undefined ? probeRunAttempt(probeRow) : undefined);

  // Connection history is a capture, a probe that got an answer or an OAuth
  // sign-in. A row that only records a failed Refresh is not one, so a
  // server that never connected keeps its Connect step.
  const oauthFlow = parseOAuthFlow(probeRow?.oauthFlow);
  const probeAnswered = Object.values(probes).some(
    (summary) => summary?.status === "ok" || summary?.status === "not-applicable",
  );
  const input: ServerFeatureEvidenceInput = {
    context:
      context ??
      (surface
        ? { transport: surface.transport, protocolVersion: surface.protocolVersion }
        : undefined),
    connected:
      options.connected ||
      surface !== undefined ||
      probeAnswered ||
      oauthFlow !== undefined,
    declared: surface && capturedAt !== undefined ? { surface, capturedAt } : undefined,
    probes: probes as ProbeSurface,
    oauthFlow,
    observations,
    checks: options.checks,
    configured: options.configured,
    setupOffered: options.setupOffered,
    checksOffered: options.checksOffered,
  };
  return { input, contextHash, capturedAt, latestAttempt, probeFailures, contexts };
}
