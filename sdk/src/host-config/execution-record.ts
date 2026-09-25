/**
 * Execution record — what a run or turn ACTUALLY ran on: requested vs
 * resolved selection, the harness runtime, the settings the request was sent
 * with, every routing attempt, the model the provider says it served, and
 * whether any of that deviated from what was asked for.
 *
 * READER SIDE. The MCPJam backend writes the record (its
 * `convex/lib/executionRecord.ts` is the source of the shape) on eval
 * iterations (`testIteration.execution`), swarm session attempts
 * (`journeyRunAttempts[].execution`) and chat turns (the `/stream` step
 * response's `execution` and the stream's finish `message.metadata.execution`).
 * This module is what the inspector and the CLI read it with, so both render
 * the same line.
 *
 * Rules every renderer inherits from here:
 *
 *  - **Absent is "not recorded", never a guess.** Rows written before the
 *    record existed carry none; {@link readExecutionRecord} returns
 *    `undefined` for them and for anything malformed, and nothing here
 *    reconstructs a record from other fields.
 *  - **No secrets.** The record names a connection, never a key. The reader
 *    copies known keys only, so a stray field on a stored row (a key, a
 *    header) never reaches a renderer, and the formatters never print a
 *    connection id.
 *  - **`maxOutputTokens === 0` means "provider default"**
 *    ({@link PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS}), never "0 tokens".
 *  - Enum values (rails, deviation kinds, attempt outcomes) are read
 *    leniently: a value a newer backend adds renders verbatim instead of
 *    hiding the whole record.
 *
 * Pure + browser-safe: no Node-only APIs.
 */

import {
  isModelSelection,
  type ModelConnectionRef,
  type RequestedModelSelection,
} from "./model-selection.js";

// ── Types ────────────────────────────────────────────────────────────────

/** Which rail served (or was meant to serve) the call. */
export const EXECUTION_RAILS = [
  "gateway",
  "openrouter",
  "orgCloud",
  "local",
] as const;
export type KnownExecutionRail = (typeof EXECUTION_RAILS)[number];
/** A known rail, or a value a newer backend added (rendered verbatim). */
export type ExecutionRail = KnownExecutionRail | (string & {});

export const EXECUTION_DEVIATION_KINDS = [
  "provider_fallback",
  "model_substitution",
  "harness_substitution",
] as const;
export type KnownExecutionDeviationKind =
  (typeof EXECUTION_DEVIATION_KINDS)[number];
export type ExecutionDeviationKind =
  | KnownExecutionDeviationKind
  | (string & {});

/** How the run's provider was offered, snapshotted at run start. */
export type ExecutionOffering = {
  rail: ExecutionRail;
  /** `gateway`, `openrouter`, `azure`, `custom:<slug>`, … */
  providerKey: string;
  /** The connection's user-facing label, when it has one. */
  connectionLabel?: string;
  /** Non-secret version of the connection's credential (its `updatedAt`). */
  credentialVersion?: number;
  nativeModelId?: string;
};

export type ExecutionAttemptOutcome = "ok" | "error" | (string & {});

export type ExecutionAttempt = {
  rail: ExecutionRail;
  wireModelId: string;
  outcome: ExecutionAttemptOutcome;
  /** Machine code of the failure (`provider_error`, `rate_limited`, …). */
  code?: string;
  at: number;
};

export type ExecutionDeviation = {
  kind: ExecutionDeviationKind;
  reason: string;
};

export type ExecutionRecord = {
  /** `source: "legacy"` ⇒ the stored choice had no source; it was inferred. */
  requested: RequestedModelSelection;
  resolved: {
    rail: ExecutionRail;
    wireModelId: string;
    connectionRef?: ModelConnectionRef;
    nativeModelId?: string;
    offering: ExecutionOffering;
  };
  harness?: { id: string; runtimeVersion: string };
  effectiveSettings: {
    reasoningEffort?: string;
    temperature?: number;
    /** {@link PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS} ⇒ the provider's default. */
    maxOutputTokens: number;
  };
  attempts: ExecutionAttempt[];
  /** Model id the provider reported serving, when it reported one. */
  upstreamModel?: string;
  deviation?: ExecutionDeviation;
};

/**
 * `effectiveSettings.maxOutputTokens` when the request set no ceiling and the
 * provider's own default applied. Rendered as "provider default".
 */
export const PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS = 0;

/** Attempts the backend keeps on one record (first kept, later ones roll). */
export const MAX_EXECUTION_ATTEMPTS = 32;

// ── Reading an untrusted value ───────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readRequested(value: unknown): RequestedModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  if (value.source === "legacy") {
    const modelId = nonEmptyString(value.modelId);
    return modelId ? { source: "legacy", modelId } : undefined;
  }
  if (!isModelSelection(value)) return undefined;
  const connectionRef = readConnectionRef(value.connectionRef);
  return {
    modelId: value.modelId,
    source: value.source,
    ...(connectionRef ? { connectionRef } : {}),
    ...(value.nativeModelId !== undefined
      ? { nativeModelId: value.nativeModelId }
      : {}),
    ...(value.settings
      ? {
          settings: {
            ...(value.settings.reasoningEffort !== undefined
              ? { reasoningEffort: value.settings.reasoningEffort }
              : {}),
            ...(value.settings.temperature !== undefined
              ? { temperature: value.settings.temperature }
              : {}),
          },
        }
      : {}),
    fallback: {
      provider: value.fallback.provider,
      model: value.fallback.model,
    },
  };
}

function readConnectionRef(value: unknown): ModelConnectionRef | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "orgProvider") {
    const id = nonEmptyString(value.id);
    return id ? { kind: "orgProvider", id } : undefined;
  }
  if (value.kind === "localProvider") {
    const providerKey = nonEmptyString(value.providerKey);
    if (!providerKey) return undefined;
    const customProviderName = nonEmptyString(value.customProviderName);
    return {
      kind: "localProvider",
      providerKey,
      ...(customProviderName ? { customProviderName } : {}),
    };
  }
  return undefined;
}

function readOffering(value: unknown): ExecutionOffering | undefined {
  if (!isRecord(value)) return undefined;
  const rail = nonEmptyString(value.rail);
  const providerKey = nonEmptyString(value.providerKey);
  if (!rail || !providerKey) return undefined;
  const connectionLabel = nonEmptyString(value.connectionLabel);
  const credentialVersion = finiteNumber(value.credentialVersion);
  const nativeModelId = nonEmptyString(value.nativeModelId);
  return {
    rail,
    providerKey,
    ...(connectionLabel ? { connectionLabel } : {}),
    ...(credentialVersion !== undefined ? { credentialVersion } : {}),
    ...(nativeModelId ? { nativeModelId } : {}),
  };
}

function readAttempt(value: unknown): ExecutionAttempt | undefined {
  if (!isRecord(value)) return undefined;
  const rail = nonEmptyString(value.rail);
  const wireModelId = nonEmptyString(value.wireModelId);
  const outcome = nonEmptyString(value.outcome);
  const at = finiteNumber(value.at);
  if (!rail || !wireModelId || !outcome || at === undefined) return undefined;
  const code = nonEmptyString(value.code);
  return { rail, wireModelId, outcome, ...(code ? { code } : {}), at };
}

/**
 * Read an execution record off an untrusted value (a Convex row, an API
 * response, a stream message's metadata).
 *
 * `undefined` for an absent or malformed record — render that as "not
 * recorded", never as a guess. Known keys only at every level. Individual
 * malformed attempts are dropped; the rest of the record still reads.
 */
export function readExecutionRecord(
  value: unknown
): ExecutionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const requested = readRequested(value.requested);
  const resolvedValue = value.resolved;
  if (!requested || !isRecord(resolvedValue)) return undefined;
  const rail = nonEmptyString(resolvedValue.rail);
  const wireModelId = nonEmptyString(resolvedValue.wireModelId);
  const offering = readOffering(resolvedValue.offering);
  if (!rail || !wireModelId || !offering) return undefined;
  const settingsValue = value.effectiveSettings;
  if (!isRecord(settingsValue)) return undefined;
  const maxOutputTokens = finiteNumber(settingsValue.maxOutputTokens);
  if (maxOutputTokens === undefined) return undefined;

  const connectionRef = readConnectionRef(resolvedValue.connectionRef);
  const nativeModelId = nonEmptyString(resolvedValue.nativeModelId);
  const harnessValue = value.harness;
  const harnessId = isRecord(harnessValue)
    ? nonEmptyString(harnessValue.id)
    : undefined;
  const runtimeVersion = isRecord(harnessValue)
    ? nonEmptyString(harnessValue.runtimeVersion)
    : undefined;
  const reasoningEffort = nonEmptyString(settingsValue.reasoningEffort);
  const temperature = finiteNumber(settingsValue.temperature);
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.flatMap((entry) => {
        const attempt = readAttempt(entry);
        return attempt ? [attempt] : [];
      })
    : [];
  const upstreamModel = nonEmptyString(value.upstreamModel);
  const deviationValue = value.deviation;
  const deviationKind = isRecord(deviationValue)
    ? nonEmptyString(deviationValue.kind)
    : undefined;
  const deviationReason = isRecord(deviationValue)
    ? typeof deviationValue.reason === "string"
      ? deviationValue.reason
      : ""
    : "";

  return {
    requested,
    resolved: {
      rail,
      wireModelId,
      ...(connectionRef ? { connectionRef } : {}),
      ...(nativeModelId ? { nativeModelId } : {}),
      offering,
    },
    ...(harnessId && runtimeVersion
      ? { harness: { id: harnessId, runtimeVersion } }
      : {}),
    effectiveSettings: {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      maxOutputTokens,
    },
    attempts,
    ...(upstreamModel ? { upstreamModel } : {}),
    ...(deviationKind
      ? { deviation: { kind: deviationKind, reason: deviationReason } }
      : {}),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────

const RAIL_LABELS: Record<KnownExecutionRail, string> = {
  gateway: "Vercel AI Gateway",
  openrouter: "OpenRouter",
  orgCloud: "organization connection",
  local: "local key",
};

/** A rail's display name ("Vercel AI Gateway", "OpenRouter", …). */
export function executionRailLabel(rail: ExecutionRail): string {
  return (RAIL_LABELS as Record<string, string>)[rail] ?? rail;
}

const DEVIATION_TITLES: Record<KnownExecutionDeviationKind, string> = {
  provider_fallback: "Provider fallback",
  model_substitution: "Model substituted",
  harness_substitution: "Harness substituted",
};

/** A deviation kind's display title; an unknown kind reads verbatim. */
export function executionDeviationTitle(kind: ExecutionDeviationKind): string {
  return (DEVIATION_TITLES as Record<string, string>)[kind] ?? kind;
}

function providerName(record: ExecutionRecord): string {
  const ref = record.resolved.connectionRef;
  if (ref?.kind === "localProvider" && ref.customProviderName) {
    return ref.customProviderName;
  }
  return record.resolved.offering.providerKey;
}

/**
 * Where the call went, in words: "Vercel AI Gateway (MCPJam key)",
 * `org connection "Prod Azure" (azure)`, "local openai key". Names the
 * connection by its label and provider, never by id or key.
 */
export function describeExecutionRoute(record: ExecutionRecord): string {
  const { rail, offering } = record.resolved;
  switch (rail) {
    case "gateway":
    case "openrouter":
      return `${executionRailLabel(rail)} (MCPJam key)`;
    case "orgCloud":
      return offering.connectionLabel
        ? `org connection "${offering.connectionLabel}" (${providerName(record)})`
        : `org ${providerName(record)} connection`;
    case "local":
      return offering.connectionLabel
        ? `local key "${offering.connectionLabel}" (${providerName(record)})`
        : `local ${providerName(record)} key`;
    default:
      return `${rail} (${offering.providerKey})`;
  }
}

/** "max output provider default" / "max output 4,096 tokens". */
export function describeMaxOutputTokens(maxOutputTokens: number): string {
  return maxOutputTokens === PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS
    ? "max output provider default"
    : `max output ${maxOutputTokens.toLocaleString("en-US")} tokens`;
}

/** The effective settings as short phrases, in a fixed order. */
export function describeExecutionSettings(record: ExecutionRecord): string[] {
  const settings = record.effectiveSettings;
  return [
    ...(settings.reasoningEffort
      ? [`effort ${settings.reasoningEffort}`]
      : []),
    ...(settings.temperature !== undefined
      ? [`temperature ${settings.temperature}`]
      : []),
    describeMaxOutputTokens(settings.maxOutputTokens),
  ];
}

/** The model as run, with the deployment id and provider-reported model. */
export function describeExecutionModel(record: ExecutionRecord): string {
  const { wireModelId, nativeModelId } = record.resolved;
  const qualifiers = [
    ...(nativeModelId && nativeModelId !== wireModelId
      ? [`deployment ${nativeModelId}`]
      : []),
    ...(record.upstreamModel && record.upstreamModel !== wireModelId
      ? [`provider reported ${record.upstreamModel}`]
      : []),
  ];
  return qualifiers.length > 0
    ? `${wireModelId} (${qualifiers.join(", ")})`
    : wireModelId;
}

/**
 * THE provenance line, identical on every surface:
 * "Ran on <model> via <rail/connection>, <harness vX>, effort/temp, max output".
 * The harness part is present only when the record names one.
 */
export function formatExecutionProvenanceLine(record: ExecutionRecord): string {
  const parts = [
    `Ran on ${describeExecutionModel(record)} via ${describeExecutionRoute(record)}`,
    ...(record.harness
      ? [`${record.harness.id} v${record.harness.runtimeVersion}`]
      : []),
    ...describeExecutionSettings(record),
  ];
  return parts.join(", ");
}

const REQUESTED_SOURCE_LABELS: Record<string, string> = {
  hosted: "MCPJam-hosted",
  org: "organization connection",
  local: "local key",
};

/**
 * What was asked for. A legacy (`source: "legacy"`) request says so: the
 * saved choice named only a model id, so the source was inferred at run time.
 */
export function describeExecutionRequest(record: ExecutionRecord): string {
  const requested = record.requested;
  if (requested.source === "legacy") {
    return `Requested ${requested.modelId} (saved without a source; inferred at run time)`;
  }
  const source = REQUESTED_SOURCE_LABELS[requested.source] ?? requested.source;
  const fallback =
    requested.fallback.provider === "none"
      ? "no fallback permitted"
      : `${executionRailLabel(requested.fallback.provider)} fallback permitted`;
  return `Requested ${requested.modelId} (${source}, ${fallback})`;
}

/** One line per routing attempt, in order. */
export function describeExecutionAttempts(record: ExecutionRecord): string[] {
  return record.attempts.map((attempt, index) => {
    const outcome =
      attempt.outcome === "ok"
        ? "ok"
        : attempt.outcome === "error"
          ? `failed${attempt.code ? ` (${attempt.code})` : ""}`
          : `${attempt.outcome}${attempt.code ? ` (${attempt.code})` : ""}`;
    return `Attempt ${index + 1}: ${executionRailLabel(attempt.rail)} · ${attempt.wireModelId} · ${outcome}`;
  });
}

/** Everything a renderer needs, derived once. */
export type ExecutionProvenanceSummary = {
  line: string;
  request: string;
  attempts: string[];
  deviation?: { kind: ExecutionDeviationKind; title: string; reason: string };
};

export function summarizeExecutionRecord(
  record: ExecutionRecord
): ExecutionProvenanceSummary {
  return {
    line: formatExecutionProvenanceLine(record),
    request: describeExecutionRequest(record),
    attempts: describeExecutionAttempts(record),
    ...(record.deviation
      ? {
          deviation: {
            kind: record.deviation.kind,
            title: executionDeviationTitle(record.deviation.kind),
            reason: record.deviation.reason,
          },
        }
      : {}),
  };
}

/** "Deviation: Provider fallback — <reason>" (reason omitted when empty). */
export function formatExecutionDeviationLine(
  deviation: ExecutionDeviation
): string {
  const title = executionDeviationTitle(deviation.kind);
  return deviation.reason.trim().length > 0
    ? `Deviation: ${title} — ${deviation.reason}`
    : `Deviation: ${title}`;
}
