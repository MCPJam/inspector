import { REGISTRATION_FAILURE_PREFIX } from "./shared/dynamic-client-registration.js";
import {
  extractResponseErrorReason,
  toSingleLine,
} from "./shared/response-error.js";
import {
  getStepIndex,
  getStepInfo,
} from "./shared/step-metadata.js";
import {
  MAX_REPORTED,
  sanitizeOAuthHeaders,
  sanitizeOAuthTraceValue,
  sanitizeOAuthUrl,
  sanitizeTraceErrorMessage,
} from "./trace-redaction.js";
import type {
  HttpHistoryEntry,
  OAuthFlowState,
  OAuthFlowStep,
} from "./types.js";

export type OAuthTraceStepStatus = "pending" | "success" | "error";

export interface OAuthTraceStepSnapshot {
  step: OAuthFlowStep;
  title: string;
  status: OAuthTraceStepStatus;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
  recovered?: boolean;
  recoveredAt?: number;
  recoveryMessage?: string;
  startedAt: number;
  completedAt?: number;
}

export interface OAuthTraceSnapshot {
  version: 1;
  currentStep: OAuthFlowStep;
  steps: OAuthTraceStepSnapshot[];
  httpHistory: HttpHistoryEntry[];
  error?: string;
}

export interface OAuthTraceProjectionContext {
  syntheticStepTimestamps: Partial<Record<OAuthFlowStep, number>>;
  lastSyntheticTimestamp: number;
}

type OAuthTraceEntryDraft = {
  step: OAuthFlowStep;
  startedAt: number;
  completedAt?: number;
  message?: string;
  details?: Record<string, unknown>;
  error?: string;
  recovered?: boolean;
  recoveredAt?: number;
  recoveryMessage?: string;
};

function cloneHttpHistoryEntry(entry: HttpHistoryEntry): HttpHistoryEntry {
  return JSON.parse(JSON.stringify(entry)) as HttpHistoryEntry;
}

function sanitizeHttpHistoryEntry(entry: HttpHistoryEntry): HttpHistoryEntry {
  return {
    ...entry,
    request: {
      ...entry.request,
      // The URL carries credentials too: an authorization request puts `state`
      // in the query, and error/callback URLs can carry `code`. Redacting only
      // headers and body left those in every sanitized history entry.
      url: sanitizeOAuthUrl(entry.request.url),
      headers: sanitizeOAuthHeaders(entry.request.headers),
      body: sanitizeOAuthTraceValue(entry.request.body),
    },
    ...(entry.response
      ? {
          response: {
            ...entry.response,
            headers: sanitizeOAuthHeaders(entry.response.headers),
            body: sanitizeOAuthTraceValue(entry.response.body),
          },
        }
      : {}),
    ...(entry.error
      ? {
          error: {
            ...entry.error,
            // `message` is free-form and interpolates upstream fields, so it
            // needs redacting just as much as `details` does.
            ...(entry.error.message
              ? { message: sanitizeTraceErrorMessage(entry.error.message) }
              : {}),
            details: sanitizeOAuthTraceValue(entry.error.details),
          },
        }
      : {}),
  };
}

function maxDefined(
  ...values: Array<number | undefined>
): number | undefined {
  const defined = values.filter((value): value is number => value != null);
  if (defined.length === 0) {
    return undefined;
  }

  return Math.max(...defined);
}

export function createOAuthTraceProjectionContext(): OAuthTraceProjectionContext {
  return {
    syntheticStepTimestamps: {},
    lastSyntheticTimestamp: 0,
  };
}

function readStableStepTimestamp(
  context: OAuthTraceProjectionContext | undefined,
  step: OAuthFlowStep,
  fallback: number,
): number {
  if (!context) {
    return fallback;
  }

  const existing = context.syntheticStepTimestamps[step];
  if (typeof existing === "number") {
    return existing;
  }

  return fallback;
}

function ensureStepEntry(
  entries: Map<OAuthFlowStep, OAuthTraceEntryDraft>,
  context: OAuthTraceProjectionContext | undefined,
  step: OAuthFlowStep,
  timestamp: number,
): OAuthTraceEntryDraft {
  const stableTimestamp = readStableStepTimestamp(context, step, timestamp);
  const existing = entries.get(step);
  if (existing) {
    existing.startedAt = Math.min(existing.startedAt, stableTimestamp);
    existing.completedAt = Math.max(
      existing.completedAt ?? stableTimestamp,
      timestamp,
    );
    return existing;
  }

  const created: OAuthTraceEntryDraft = {
    step,
    startedAt: stableTimestamp,
    completedAt: timestamp,
  };
  entries.set(step, created);
  return created;
}

function inferStepEntry(
  entries: Map<OAuthFlowStep, OAuthTraceEntryDraft>,
  context: OAuthTraceProjectionContext | undefined,
  step: OAuthFlowStep,
  condition: boolean,
  details: Record<string, unknown> | undefined,
  sanitize: boolean,
): void {
  if (!condition || entries.has(step)) {
    return;
  }

  let timestamp = Date.now();
  if (context) {
    timestamp = Math.max(timestamp, context.lastSyntheticTimestamp + 1);
    context.syntheticStepTimestamps[step] = timestamp;
    context.lastSyntheticTimestamp = timestamp;
  }

  const projectedDetails =
    details == null
      ? undefined
      : (sanitize
          ? (sanitizeOAuthTraceValue(details) as Record<string, unknown>)
          : (JSON.parse(JSON.stringify(details)) as Record<string, unknown>));

  entries.set(step, {
    step,
    startedAt: timestamp,
    completedAt: timestamp,
    details: projectedDetails,
  });
}

function didCurrentStepReachSuccess(
  entryStep: OAuthFlowStep,
  state: OAuthFlowState,
): boolean {
  if (entryStep !== state.currentStep) {
    return false;
  }

  switch (entryStep) {
    case "authorization_request":
      return Boolean(state.authorizationUrl);
    case "received_authorization_code":
      return Boolean(state.authorizationCode);
    case "received_access_token":
      return Boolean(state.accessToken);
    case "complete":
      return state.currentStep === "complete";
    default:
      return false;
  }
}

function extractResponseErrorMessage(
  response: HttpHistoryEntry["response"],
): string | undefined {
  if (!response || response.status < 400) {
    return undefined;
  }

  return (
    extractResponseErrorReason(response.body) ??
    `HTTP ${response.status} ${response.statusText}`
  );
}

function inferHttpHistoryEntryError(entry: HttpHistoryEntry): string | undefined {
  if (entry.error?.message) {
    return entry.error.message;
  }

  if (entry.step === "request_client_registration") {
    return extractResponseErrorMessage(entry.response);
  }

  return undefined;
}

function usesRecoveredDynamicClientRegistrationFallback(
  state: OAuthFlowState,
): boolean {
  if (!state.error || !state.clientId) {
    return false;
  }

  if (getStepIndex(state.currentStep) <= getStepIndex("request_client_registration")) {
    return false;
  }

  return (
    state.error.startsWith(REGISTRATION_FAILURE_PREFIX) ||
    state.error.startsWith("Client registration failed:")
  );
}

export function projectOAuthTraceSnapshot(input: {
  state: OAuthFlowState;
  context?: OAuthTraceProjectionContext;
  /**
   * When true (default), redact tokens/secrets/PII from traces. SDK consumers
   * that are local dev tools may set false to show raw request/response data.
   */
  sanitize?: boolean;
}): OAuthTraceSnapshot {
  const { state, context, sanitize: sanitizeTraces = true } = input;

  // The single projection of `state.error`. Every consumer below reads this
  // variable rather than `state.error`, so there is exactly one place where the
  // raw value crosses into display output and exactly one place to keep in sync
  // with the redaction policy. (A previous fix patched one of two fallback
  // branches and the other kept emitting the raw string.)
  const projectedStateError = state.error
    ? sanitizeTraces
      ? sanitizeTraceErrorMessage(state.error)
      : state.error
    : undefined;

  const trace: OAuthTraceSnapshot = {
    version: 1,
    currentStep: state.currentStep,
    steps: [],
    httpHistory: (state.httpHistory ?? []).map((entry) =>
      sanitizeTraces ? sanitizeHttpHistoryEntry(entry) : cloneHttpHistoryEntry(entry),
    ),
    ...(projectedStateError ? { error: projectedStateError } : {}),
  };

  const currentStepIndex = getStepIndex(state.currentStep);
  const entries = new Map<OAuthFlowStep, OAuthTraceEntryDraft>();

  for (const entry of state.httpHistory ?? []) {
    const record = ensureStepEntry(entries, context, entry.step, entry.timestamp);
    if (!record.details) {
      record.details = {
        request: (sanitizeTraces
          ? sanitizeOAuthTraceValue(entry.request)
          : entry.request) as Record<string, unknown>,
        ...(entry.response
          ? {
              response: (sanitizeTraces
                ? sanitizeOAuthTraceValue(entry.response)
                : entry.response) as Record<string, unknown>,
            }
          : {}),
      };
    }
    const entryError = inferHttpHistoryEntryError(entry);
    if (entryError) {
      // Raw mode skips the redactor, which is also what bounds this string.
      // The error is derived from a response body and can be an HTML error
      // page in full; a step's error is a line, and the untruncated body is
      // already on `record.details.response` right above.
      //
      // Collapsed after both, in either mode: the body's own newlines would
      // otherwise reach the step error, and collapsing first would hide the
      // redactor's cut from its credential tail guards.
      record.error = toSingleLine(
        sanitizeTraces
          ? sanitizeTraceErrorMessage(entryError)
          : entryError.slice(0, MAX_REPORTED),
      );
    }
  }

  for (const log of state.infoLogs ?? []) {
    const record = ensureStepEntry(entries, context, log.step, log.timestamp);
    record.message = log.label;
    const logData = sanitizeTraces
      ? sanitizeOAuthTraceValue(log.data)
      : log.data;
    if (
      logData &&
      typeof logData === "object" &&
      logData !== null &&
      !Array.isArray(logData)
    ) {
      record.details = logData as Record<string, unknown>;
    }
    if (log.error?.message) {
      record.error = sanitizeTraces
        ? sanitizeTraceErrorMessage(log.error.message)
        : log.error.message;
    }
  }

  const baseTimestamp = Math.max(
    Date.now(),
    ...(state.httpHistory ?? []).map((entry) => entry.timestamp),
    ...(state.infoLogs ?? []).map((entry) => entry.timestamp),
    context?.lastSyntheticTimestamp ?? 0,
  );
  if (context) {
    context.lastSyntheticTimestamp = Math.max(
      context.lastSyntheticTimestamp,
      baseTimestamp,
    );
  }

  inferStepEntry(
    entries,
    context,
    "received_client_credentials",
    Boolean(state.clientId),
    {
      clientId: state.clientId,
    },
    sanitizeTraces,
  );
  inferStepEntry(
    entries,
    context,
    "generate_pkce_parameters",
    Boolean(state.codeVerifier),
    {
      codeVerifier: state.codeVerifier,
    },
    sanitizeTraces,
  );
  inferStepEntry(
    entries,
    context,
    "authorization_request",
    Boolean(state.authorizationUrl),
    {
      authorizationUrl: state.authorizationUrl,
    },
    sanitizeTraces,
  );
  inferStepEntry(
    entries,
    context,
    "received_authorization_code",
    Boolean(state.authorizationCode),
    state.authorizationCode ? { code: state.authorizationCode } : undefined,
    sanitizeTraces,
  );
  inferStepEntry(
    entries,
    context,
    "received_access_token",
    Boolean(state.accessToken),
    {
      tokenType: state.tokenType,
      expiresIn: state.expiresIn,
    },
    sanitizeTraces,
  );
  inferStepEntry(
    entries,
    context,
    "complete",
    state.currentStep === "complete",
    undefined,
    sanitizeTraces,
  );

  const registrationEntry = entries.get("request_client_registration");
  if (
    registrationEntry?.error &&
    getStepIndex(state.currentStep) > getStepIndex("request_client_registration") &&
    Boolean(state.clientId)
  ) {
    registrationEntry.recovered = true;
    registrationEntry.recoveredAt = maxDefined(
      registrationEntry.recoveredAt,
      registrationEntry.completedAt,
      entries.get("received_client_credentials")?.startedAt,
    );
    registrationEntry.recoveryMessage =
      "Using pre-registered client credentials after registration failed.";
  }

  if (
    state.error &&
    !usesRecoveredDynamicClientRegistrationFallback(state) &&
    !entries.has(state.currentStep)
  ) {
    inferStepEntry(entries, context, state.currentStep, true, undefined, sanitizeTraces);
    const currentEntry = entries.get(state.currentStep);
    if (currentEntry) {
      currentEntry.error = projectedStateError;
    }
  }

  trace.steps = Array.from(entries.values())
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        getStepIndex(left.step) - getStepIndex(right.step),
    )
    .map((entry) => {
      const stepIndex = getStepIndex(entry.step);
      const usesStateError =
        entry.step === state.currentStep &&
        Boolean(state.error) &&
        !usesRecoveredDynamicClientRegistrationFallback(state);
      const error =
        entry.error ?? (usesStateError ? projectedStateError : undefined);
      const status =
        entry.recovered
          ? "success"
          : error
          ? "error"
          : stepIndex < currentStepIndex ||
              state.currentStep === "complete" ||
              didCurrentStepReachSuccess(entry.step, state)
            ? "success"
            : entry.step === state.currentStep
              ? "pending"
              : "success";

      return {
        step: entry.step,
        title: getStepInfo(entry.step).title,
        status,
        message: entry.message ?? getStepInfo(entry.step).summary,
        ...(error ? { error } : {}),
        ...(entry.details ? { details: entry.details } : {}),
        ...(entry.recovered ? { recovered: true } : {}),
        ...(entry.recoveredAt ? { recoveredAt: entry.recoveredAt } : {}),
        ...(entry.recoveryMessage ? { recoveryMessage: entry.recoveryMessage } : {}),
        startedAt: entry.startedAt,
        completedAt: status === "pending" ? undefined : entry.completedAt,
      } satisfies OAuthTraceStepSnapshot;
    });

  return trace;
}
