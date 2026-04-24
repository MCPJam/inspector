import {
  getStepIndex,
  getStepInfo,
  type HttpHistoryEntry,
  type OAuthFlowStep,
  type OAuthTraceSnapshot,
  type OAuthTraceStepSnapshot,
  type OAuthTraceStepStatus,
} from "@mcpjam/sdk/browser";

export type OAuthTraceSource =
  | "interactive_connect"
  | "callback"
  | "refresh"
  | "hosted_callback";

export type { OAuthTraceStepStatus };
export type OAuthTraceStep = OAuthTraceStepSnapshot;

export interface OAuthTrace extends OAuthTraceSnapshot {
  source: OAuthTraceSource;
  serverName?: string;
  serverUrl?: string;
}

const OAUTH_TRACE_STORAGE_PREFIX = "mcp-oauth-trace-";

function storageKey(serverName: string): string {
  return `${OAUTH_TRACE_STORAGE_PREFIX}${serverName}`;
}

const MAX_OAUTH_TRACE_HTTP_HISTORY = 50;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function trimHttpHistory(httpHistory: HttpHistoryEntry[]): HttpHistoryEntry[] {
  if (httpHistory.length <= MAX_OAUTH_TRACE_HTTP_HISTORY) {
    return httpHistory;
  }

  return httpHistory.slice(-MAX_OAUTH_TRACE_HTTP_HISTORY);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pickPreferredStepText(input: {
  existing?: string;
  incoming?: string;
  title: string;
}): string | undefined {
  const { existing, incoming, title } = input;
  if (!isNonEmptyString(incoming)) {
    return existing;
  }
  if (!isNonEmptyString(existing)) {
    return incoming;
  }

  const existingIsGeneric = existing === title;
  const incomingIsGeneric = incoming === title;

  if (existingIsGeneric && !incomingIsGeneric) {
    return incoming;
  }
  if (!existingIsGeneric && incomingIsGeneric) {
    return existing;
  }

  return incoming;
}

function mergeStepDetails(
  existing?: Record<string, unknown>,
  incoming?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
  };
}

function mergeStepStatus(
  existing: OAuthTraceStepStatus,
  incoming: OAuthTraceStepStatus,
): OAuthTraceStepStatus {
  if (incoming === "pending" && existing !== "pending") {
    return existing;
  }

  return incoming;
}

function mergeStepEntries(
  existing: OAuthTraceStepSnapshot,
  incoming: OAuthTraceStepSnapshot,
): OAuthTraceStepSnapshot {
  const title = incoming.title || existing.title;
  const status = mergeStepStatus(existing.status, incoming.status);
  const message = pickPreferredStepText({
    existing: existing.message,
    incoming: incoming.message,
    title,
  });
  const recoveryMessage = pickPreferredStepText({
    existing: existing.recoveryMessage,
    incoming: incoming.recoveryMessage,
    title,
  });
  const completedAt =
    status === "pending"
      ? undefined
      : maxDefined(existing.completedAt, incoming.completedAt);
  const details = mergeStepDetails(existing.details, incoming.details);
  const recovered = existing.recovered === true || incoming.recovered === true;
  const recoveredAt = maxDefined(existing.recoveredAt, incoming.recoveredAt);
  const error =
    status === "error" || recovered
      ? incoming.error ?? existing.error
      : undefined;

  return {
    step: incoming.step,
    title,
    status,
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
    ...(details ? { details } : {}),
    ...(recovered ? { recovered } : {}),
    ...(recoveredAt ? { recoveredAt } : {}),
    ...(recoveryMessage ? { recoveryMessage } : {}),
    startedAt: Math.min(existing.startedAt, incoming.startedAt),
    ...(completedAt ? { completedAt } : {}),
  };
}

function mergeTraceSteps(
  baseSteps: OAuthTraceStepSnapshot[],
  nextSteps: OAuthTraceStepSnapshot[],
): OAuthTraceStepSnapshot[] {
  const merged = new Map<OAuthFlowStep, OAuthTraceStepSnapshot>();

  [...baseSteps, ...nextSteps].forEach((step) => {
    const existing = merged.get(step.step);
    if (!existing) {
      merged.set(step.step, clone(step));
      return;
    }

    merged.set(step.step, mergeStepEntries(existing, step));
  });

  return Array.from(merged.values()).sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      getStepIndex(left.step) - getStepIndex(right.step),
  );
}

function buildHttpHistoryEntryKey(entry: HttpHistoryEntry): string {
  return JSON.stringify({
    step: entry.step,
    timestamp: entry.timestamp,
    request: entry.request,
    response: entry.response,
    error: entry.error,
  });
}

function mergeHttpHistory(
  baseHttpHistory: HttpHistoryEntry[],
  nextHttpHistory: HttpHistoryEntry[],
): HttpHistoryEntry[] {
  const merged = new Map<string, HttpHistoryEntry>();

  [...baseHttpHistory, ...nextHttpHistory].forEach((entry) => {
    merged.set(buildHttpHistoryEntryKey(entry), clone(entry));
  });

  return trimHttpHistory(
    Array.from(merged.values()).sort(
      (left, right) => left.timestamp - right.timestamp,
    ),
  );
}

function deriveTraceError(
  steps: OAuthTraceStepSnapshot[],
  fallback?: string,
): string | undefined {
  const failureStep = [...steps]
    .reverse()
    .find((step) => step.status === "error" && !step.recovered);
  return failureStep?.error ?? fallback;
}

function buildPersistableTrace(
  trace: OAuthTrace,
  options: { dropHttpHistory?: boolean } = {},
): OAuthTrace {
  return clone({
    ...trace,
    httpHistory: options.dropHttpHistory ? [] : trimHttpHistory(trace.httpHistory),
  });
}

export function createOAuthTrace(input: {
  source: OAuthTraceSource;
  serverName?: string;
  serverUrl?: string;
}): OAuthTrace {
  return {
    version: 1,
    source: input.source,
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    currentStep: "idle",
    steps: [],
    httpHistory: [],
  };
}

export function buildOAuthTraceFromSnapshot(input: {
  source: OAuthTraceSource;
  serverName?: string;
  serverUrl?: string;
  snapshot: OAuthTraceSnapshot;
}): OAuthTrace {
  return {
    version: input.snapshot.version,
    source: input.source,
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    currentStep: input.snapshot.currentStep,
    steps: input.snapshot.steps,
    httpHistory: input.snapshot.httpHistory,
    ...(input.snapshot.error ? { error: input.snapshot.error } : {}),
  };
}

export function loadOAuthTrace(serverName: string): OAuthTrace | undefined {
  try {
    const raw = localStorage.getItem(storageKey(serverName));
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as OAuthTrace;
    if (parsed?.version !== 1 || !Array.isArray(parsed.steps)) {
      return undefined;
    }
    parsed.httpHistory = Array.isArray(parsed.httpHistory)
      ? parsed.httpHistory
      : [];
    return parsed;
  } catch {
    return undefined;
  }
}

export function clearPersistedOAuthTraces(): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(OAUTH_TRACE_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      localStorage.removeItem(key);
    });
  } catch {
    // Ignore storage access failures; startup should continue without trace migration.
  }
}

export function saveOAuthTrace(serverName: string, trace: OAuthTrace): void {
  try {
    localStorage.setItem(
      storageKey(serverName),
      JSON.stringify(buildPersistableTrace(trace)),
    );
  } catch (error) {
    console.warn("Failed to persist OAuth trace with HTTP history.", error);

    try {
      localStorage.setItem(
        storageKey(serverName),
        JSON.stringify(buildPersistableTrace(trace, { dropHttpHistory: true })),
      );
    } catch (retryError) {
      console.warn("Failed to persist OAuth trace.", retryError);
    }
  }
}

export function clearOAuthTrace(serverName: string): void {
  localStorage.removeItem(storageKey(serverName));
}

export function startOAuthTraceStep(
  trace: OAuthTrace,
  step: OAuthFlowStep,
  input: {
    message?: string;
    details?: Record<string, unknown>;
  } = {},
): void {
  const existing = trace.steps.find(
    (entry) => entry.step === step && entry.status === "pending",
  );
  if (existing) {
    existing.message = input.message ?? existing.message;
    existing.details = input.details ?? existing.details;
    trace.currentStep = step;
    return;
  }

  trace.currentStep = step;
  trace.error = undefined;
  trace.steps.push({
    step,
    title: getStepInfo(step).title,
    status: "pending",
    message: input.message,
    details: input.details,
    startedAt: Date.now(),
  });
}

export function completeOAuthTraceStep(
  trace: OAuthTrace,
  step: OAuthFlowStep,
  input: {
    message?: string;
    details?: Record<string, unknown>;
  } = {},
): void {
  const existing = [...trace.steps]
    .reverse()
    .find((entry) => entry.step === step && entry.status === "pending");

  if (existing) {
    existing.status = "success";
    existing.message = input.message ?? existing.message;
    existing.details = input.details ?? existing.details;
    existing.completedAt = Date.now();
  } else {
    trace.steps.push({
      step,
      title: getStepInfo(step).title,
      status: "success",
      message: input.message,
      details: input.details,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
  }

  trace.currentStep = step;
}

export function failOAuthTraceStep(
  trace: OAuthTrace,
  step: OAuthFlowStep,
  error: unknown,
  input: {
    message?: string;
    details?: Record<string, unknown>;
  } = {},
): void {
  const errorMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const existing = [...trace.steps]
    .reverse()
    .find((entry) => entry.step === step && entry.status === "pending");

  if (existing) {
    existing.status = "error";
    existing.message = input.message ?? existing.message;
    existing.error = errorMessage;
    existing.details = input.details ?? existing.details;
    existing.completedAt = Date.now();
  } else {
    trace.steps.push({
      step,
      title: getStepInfo(step).title,
      status: "error",
      message: input.message,
      error: errorMessage,
      details: input.details,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
  }

  trace.currentStep = step;
  trace.error = errorMessage;
}

export function appendOAuthTraceHttpHistory(
  trace: OAuthTrace,
  entry: HttpHistoryEntry,
): void {
  trace.httpHistory.push(entry);
  trace.httpHistory = trimHttpHistory(trace.httpHistory);
}

export function resolveOAuthTraceStepError(
  trace: OAuthTrace,
  step: OAuthFlowStep,
  input: { message?: string } = {},
): void {
  const existing = [...trace.steps]
    .reverse()
    .find((entry) => entry.step === step && entry.status === "error" && !entry.recovered);

  if (!existing) {
    return;
  }

  existing.recovered = true;
  existing.recoveredAt = Date.now();
  existing.recoveryMessage = input.message ?? existing.recoveryMessage;

  const remainingFailure = [...trace.steps]
    .reverse()
    .find((entry) => entry.status === "error" && !entry.recovered);
  trace.error = remainingFailure?.error;
}

export function mergeOAuthTraces(
  base: OAuthTrace | undefined,
  next: OAuthTrace,
): OAuthTrace {
  if (!base) {
    return buildPersistableTrace(next);
  }

  const steps = mergeTraceSteps(base.steps, next.steps);
  const httpHistory = mergeHttpHistory(base.httpHistory, next.httpHistory);
  const error = deriveTraceError(steps, next.error);

  return buildPersistableTrace({
    version: 1,
    source: next.source,
    serverName: next.serverName ?? base.serverName,
    serverUrl: next.serverUrl ?? base.serverUrl,
    currentStep: next.currentStep,
    steps,
    httpHistory,
    ...(error ? { error } : {}),
  });
}

export function getOAuthTraceFailureStep(
  trace: OAuthTrace | undefined,
): OAuthTraceStep | undefined {
  if (!trace) {
    return undefined;
  }

  return [...trace.steps]
    .reverse()
    .find((entry) => entry.status === "error" && !entry.recovered);
}

export function getOAuthTraceSummary(
  trace: OAuthTrace | undefined,
): string | undefined {
  const failure = getOAuthTraceFailureStep(trace);
  if (!failure?.error) {
    return undefined;
  }

  return `${failure.title}: ${failure.error}`;
}
