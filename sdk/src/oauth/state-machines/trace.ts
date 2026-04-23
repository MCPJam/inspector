import {
  getStepIndex,
  getStepInfo,
} from "./shared/step-metadata.js";
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
};

type OAuthRequestFields = Record<string, string>;

const SENSITIVE_FIELD_NAMES = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code",
  "code_verifier",
  "authorization_code",
  "authorization",
  "cookie",
  "set_cookie",
  "api_key",
]);

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^api-key$/i,
  /^apikey$/i,
  /^x-auth-token$/i,
  /^x-csrf-token$/i,
  /^x-session-token$/i,
  /^x-access-token$/i,
  /^x-refresh-token$/i,
  /^x-client-secret$/i,
  /^x-credential$/i,
];

function normalizeSensitiveKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveTraceFieldName(key: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(normalizeSensitiveKey(key));
}

function isSensitiveHeaderName(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key)) ||
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(
      normalized,
    ) ||
    /(^|_)api_?key(_|$)/.test(normalized)
  );
}

function isSensitiveQueryParamName(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(
      normalized,
    ) ||
    /(^|_)api_?key(_|$)/.test(normalized)
  );
}

function redactSensitiveValue(value: unknown): string {
  if (typeof value !== "string") {
    return "[redacted]";
  }

  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 4)}...[redacted]...${value.slice(-2)}`;
}

function parseOAuthRequestFields(
  body: unknown,
): OAuthRequestFields | undefined {
  if (!body) return undefined;

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) {
      return undefined;
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const entries = Object.entries(parsed).flatMap(([key, value]) => {
            if (typeof value === "string") {
              return [[key, value] as const];
            }
            if (typeof value === "number" || typeof value === "boolean") {
              return [[key, String(value)] as const];
            }
            return [];
          });
          return entries.length > 0 ? Object.fromEntries(entries) : undefined;
        }
      } catch {
        // Fall through to URLSearchParams parsing.
      }
    }

    const params = new URLSearchParams(trimmed);
    const entries = Object.fromEntries(params.entries());
    return Object.keys(entries).length > 0 ? entries : undefined;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const entries = Object.entries(body).flatMap(([key, value]) => {
    if (typeof value === "string") {
      return [[key, value] as const];
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return [[key, String(value)] as const];
    }
    return [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeOAuthUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryParamName(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    if (url.hash) {
      url.hash = "#[redacted]";
    }
    return url.toString();
  } catch {
    return rawUrl.replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
      "Bearer [redacted]",
    );
  }
}

function sanitizeOAuthTraceString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeOAuthUrl(trimmed);
  }

  const looksStructured =
    trimmed.includes("=") ||
    trimmed.includes("&") ||
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")));
  if (looksStructured) {
    const parsed = parseOAuthRequestFields(trimmed);
    if (parsed) {
      return sanitizeOAuthTraceValue(parsed);
    }
  }

  return trimmed
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|code_verifier)\b(\s*[:=]\s*)([^\s&,;]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}[redacted]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]");
}

function sanitizeOAuthTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOAuthTraceValue(item));
  }

  if (typeof value === "string") {
    return sanitizeOAuthTraceString(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (isSensitiveTraceFieldName(key)) {
        return [key, redactSensitiveValue(entryValue)];
      }
      return [key, sanitizeOAuthTraceValue(entryValue)];
    }),
  );
}

function sanitizeOAuthHeaderValue(value: string): string {
  const sanitized = sanitizeOAuthTraceString(value);
  if (typeof sanitized === "string") {
    return sanitized;
  }
  return redactSensitiveValue(value);
}

function sanitizeOAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (isSensitiveHeaderName(key)) {
        return [key, redactSensitiveValue(value)];
      }
      return [key, sanitizeOAuthHeaderValue(value)];
    }),
  );
}

function sanitizeHttpHistoryEntry(entry: HttpHistoryEntry): HttpHistoryEntry {
  return {
    ...entry,
    request: {
      ...entry.request,
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
            details: sanitizeOAuthTraceValue(entry.error.details),
          },
        }
      : {}),
  };
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
  details?: Record<string, unknown>,
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

  entries.set(step, {
    step,
    startedAt: timestamp,
    completedAt: timestamp,
    details:
      details == null
        ? undefined
        : (sanitizeOAuthTraceValue(details) as Record<string, unknown>),
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

export function projectOAuthTraceSnapshot(input: {
  state: OAuthFlowState;
  context?: OAuthTraceProjectionContext;
}): OAuthTraceSnapshot {
  const { state, context } = input;
  const trace: OAuthTraceSnapshot = {
    version: 1,
    currentStep: state.currentStep,
    steps: [],
    httpHistory: (state.httpHistory ?? []).map((entry) =>
      sanitizeHttpHistoryEntry(entry),
    ),
    ...(state.error ? { error: state.error } : {}),
  };

  const currentStepIndex = getStepIndex(state.currentStep);
  const entries = new Map<OAuthFlowStep, OAuthTraceEntryDraft>();

  for (const entry of state.httpHistory ?? []) {
    const record = ensureStepEntry(entries, context, entry.step, entry.timestamp);
    if (!record.details) {
      record.details = {
        request: sanitizeOAuthTraceValue(entry.request),
        ...(entry.response
          ? { response: sanitizeOAuthTraceValue(entry.response) }
          : {}),
      };
    }
    if (entry.error?.message) {
      record.error = entry.error.message;
    }
  }

  for (const log of state.infoLogs ?? []) {
    const record = ensureStepEntry(entries, context, log.step, log.timestamp);
    record.message = log.label;
    const sanitizedLogData = sanitizeOAuthTraceValue(log.data);
    if (
      sanitizedLogData &&
      typeof sanitizedLogData === "object" &&
      sanitizedLogData !== null &&
      !Array.isArray(sanitizedLogData)
    ) {
      record.details = sanitizedLogData as Record<string, unknown>;
    }
    if (log.error?.message) {
      record.error = log.error.message;
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

  inferStepEntry(entries, context, "request_client_registration", Boolean(state.clientId), {
    clientId: state.clientId,
  });
  inferStepEntry(entries, context, "received_client_credentials", Boolean(state.clientId), {
    clientId: state.clientId,
  });
  inferStepEntry(entries, context, "generate_pkce_parameters", Boolean(state.codeVerifier), {
    codeVerifier: redactSensitiveValue(state.codeVerifier),
  });
  inferStepEntry(entries, context, "authorization_request", Boolean(state.authorizationUrl), {
    authorizationUrl: state.authorizationUrl,
  });
  inferStepEntry(
    entries,
    context,
    "received_authorization_code",
    Boolean(state.authorizationCode),
    state.authorizationCode
      ? { code: redactSensitiveValue(state.authorizationCode) }
      : undefined,
  );
  inferStepEntry(entries, context, "received_access_token", Boolean(state.accessToken), {
    tokenType: state.tokenType,
    expiresIn: state.expiresIn,
  });
  inferStepEntry(entries, context, "complete", state.currentStep === "complete");

  if (state.error && !entries.has(state.currentStep)) {
    inferStepEntry(entries, context, state.currentStep, true);
    const currentEntry = entries.get(state.currentStep);
    if (currentEntry) {
      currentEntry.error = state.error;
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
      const status =
        entry.error || (entry.step === state.currentStep && state.error)
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
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.details ? { details: entry.details } : {}),
        startedAt: entry.startedAt,
        completedAt: status === "pending" ? undefined : entry.completedAt,
      } satisfies OAuthTraceStepSnapshot;
    });

  return trace;
}
