import {
  getStepIndex,
  getStepInfo,
  type HttpHistoryEntry,
  type OAuthFlowStep,
} from "@mcpjam/sdk/browser";

export type OAuthTraceSource =
  | "interactive_connect"
  | "callback"
  | "refresh"
  | "hosted_callback";

export type OAuthTraceStepStatus = "pending" | "success" | "error";

export interface OAuthTraceStep {
  step: OAuthFlowStep;
  title: string;
  status: OAuthTraceStepStatus;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
}

export interface OAuthTrace {
  version: 1;
  source: OAuthTraceSource;
  serverName?: string;
  serverUrl?: string;
  currentStep: OAuthFlowStep;
  steps: OAuthTraceStep[];
  httpHistory: HttpHistoryEntry[];
  error?: string;
}

function storageKey(serverName: string): string {
  return `mcp-oauth-trace-${serverName}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveOAuthTrace(serverName: string, trace: OAuthTrace): void {
  localStorage.setItem(storageKey(serverName), JSON.stringify(trace));
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
}

export function mergeOAuthTraces(
  base: OAuthTrace | undefined,
  next: OAuthTrace,
): OAuthTrace {
  if (!base) {
    return clone(next);
  }

  return {
    ...clone(base),
    source: next.source,
    serverName: next.serverName ?? base.serverName,
    serverUrl: next.serverUrl ?? base.serverUrl,
    currentStep: next.currentStep,
    steps: [...base.steps, ...next.steps].sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        getStepIndex(left.step) - getStepIndex(right.step),
    ),
    httpHistory: [...base.httpHistory, ...next.httpHistory],
    error: next.error ?? base.error,
  };
}

export function getOAuthTraceFailureStep(
  trace: OAuthTrace | undefined,
): OAuthTraceStep | undefined {
  if (!trace) {
    return undefined;
  }

  return [...trace.steps]
    .reverse()
    .find((entry) => entry.status === "error");
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
