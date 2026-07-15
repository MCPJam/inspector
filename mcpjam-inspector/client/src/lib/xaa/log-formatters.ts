import {
  getXAAReceivedStepForRequest,
  getXAAStepInfo,
  getXAAStepIndex,
} from "./step-metadata";
import {
  splitHttpEntriesForDisplay,
  type HttpEntryView,
} from "@/lib/http-entry-views";
import type {
  XAAFlowState,
  XAAFlowStep,
  XAAHttpHistoryEntry,
  XAAInfoLogEntry,
} from "./types";

export interface XAAFlowCopySummary {
  serverUrl?: string;
  authzServerIssuer?: string;
  clientId?: string;
  scope?: string;
}

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString();

const stringify = (value: unknown): string =>
  typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2) ?? String(value);

const REDACTED = "[REDACTED]";
const SENSITIVE_FIELDS = new Set([
  "access_token",
  "actor_token",
  "api_key",
  "assertion",
  "authorization",
  "authorization_code",
  "client_secret",
  "code",
  "code_verifier",
  "cookie",
  "credential",
  "id_jag",
  "identity_assertion",
  "id_token",
  "password",
  "refresh_token",
  "set_cookie",
  "state",
  "subject_token",
  "token",
]);

const normalizeFieldName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();

const isSensitiveField = (name: string) =>
  SENSITIVE_FIELDS.has(normalizeFieldName(name));

const isSensitiveContainerKey = (name: string) => {
  const normalized = normalizeFieldName(name);
  return (
    SENSITIVE_FIELDS.has(normalized) ||
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(
      normalized
    ) ||
    /(^|_)api_?key(_|$)/.test(normalized)
  );
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sensitiveStringFieldPattern = [...SENSITIVE_FIELDS]
  .flatMap((field) => [
    field,
    field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    field.replaceAll("_", "-"),
  ])
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

const sensitiveStringAssignmentPattern = new RegExp(
  `\\b((?:${sensitiveStringFieldPattern})\\s*["']?\\s*[:=]\\s*["']?)([^"'&\\r\\n,}]+)`,
  "gi"
);

function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isSensitiveContainerKey(name)
        ? REDACTED
        : stringify(sanitizeString(value)),
    ])
  );
}

function sanitizeString(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return sanitizeBody(JSON.parse(trimmed));
    } catch {
      // Fall through to form/text redaction.
    }
  }

  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(sensitiveStringAssignmentPattern, `$1${REDACTED}`);
}

function sanitizeBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBody);
  if (typeof value === "string") return sanitizeString(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([name, entryValue]) => [
      name,
      isSensitiveField(name) ? REDACTED : sanitizeBody(entryValue),
    ])
  );
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveContainerKey(name)) url.searchParams.set(name, REDACTED);
    }
    if (url.hash) url.hash = `#${REDACTED}`;
    return url.toString();
  } catch {
    return String(sanitizeString(rawUrl));
  }
}

const appendError = (
  text: string,
  error: XAAInfoLogEntry["error"] | XAAHttpHistoryEntry["error"]
) => {
  if (!error) return text;
  text += `ERROR: ${stringify(sanitizeString(error.message))}\n`;
  if (
    error.details &&
    typeof error.details === "object" &&
    "stack" in error.details &&
    typeof error.details.stack === "string"
  ) {
    text += `Stack: ${stringify(sanitizeString(error.details.stack))}\n`;
  }
  return text;
};

export function generateXAAFlowText(
  flowState: XAAFlowState,
  summary: XAAFlowCopySummary,
  options?: { step?: XAAFlowStep }
): string {
  let text = "=== XAA Debugger - Flow ===\n\n";
  text += `Server URL: ${sanitizeUrl(
    summary.serverUrl || flowState.serverUrl || "Not set"
  )}\n`;
  text += `Authorization Server: ${sanitizeUrl(
    summary.authzServerIssuer ||
      flowState.authzServerIssuer ||
      "Discovered at runtime"
  )}\n`;
  text += `Client ID: ${sanitizeUrl(
    summary.clientId || flowState.clientId || "Not set"
  )}\n`;
  text += `Scope: ${String(
    sanitizeString(summary.scope || flowState.scope || "Not set")
  )}\n`;
  text += `Test mode: ${flowState.negativeTestMode}\n`;
  text += `Current step: ${flowState.currentStep}\n`;
  if (flowState.error) {
    text += `ERROR: ${stringify(sanitizeString(flowState.error))}\n`;
  }
  text += "\n";

  type TimelineEntry =
    | { type: "info"; timestamp: number; value: XAAInfoLogEntry }
    | {
        type: "http";
        timestamp: number;
        value: XAAHttpHistoryEntry;
        view: HttpEntryView;
      };

  const currentStepIndex = getXAAStepIndex(flowState.currentStep);
  const byStep = new Map<XAAFlowStep, TimelineEntry[]>();
  const add = (step: XAAFlowStep, entry: TimelineEntry) => {
    const entries = byStep.get(step) ?? [];
    entries.push(entry);
    byStep.set(step, entries);
  };

  for (const entry of flowState.infoLogs ?? []) {
    if (getXAAStepIndex(entry.step) > currentStepIndex) continue;
    if (options?.step && entry.step !== options.step) continue;
    add(entry.step, {
      type: "info",
      timestamp: entry.timestamp,
      value: entry,
    });
  }
  // Keep the request under its request step and the response under the paired
  // received step, matching the guide and sequence diagram.
  for (const item of splitHttpEntriesForDisplay<
    XAAFlowStep,
    XAAHttpHistoryEntry
  >({
    entries: flowState.httpHistory ?? [],
    pairedReceivedStep: getXAAReceivedStepForRequest,
  })) {
    if (getXAAStepIndex(item.step) > currentStepIndex) continue;
    if (options?.step && item.step !== options.step) continue;
    add(item.step, {
      type: "http",
      timestamp: item.timestamp,
      value: item.entry,
      view: item.view,
    });
  }

  const steps = options?.step
    ? [options.step]
    : Array.from(byStep.keys()).sort(
        (a, b) => getXAAStepIndex(a) - getXAAStepIndex(b)
      );
  if (steps.length === 0) return `${text}No activity yet.\n`;

  for (const step of steps) {
    const stepInfo = getXAAStepInfo(step, flowState.identityAssertionFormat);
    text += `${"=".repeat(60)}\n`;
    text += `${stepInfo.title} [${step}]\n`;
    text += `${"=".repeat(60)}\n`;
    text += `${stepInfo.summary}\n\n`;

    const entries = (byStep.get(step) ?? []).sort(
      (a, b) => a.timestamp - b.timestamp
    );
    for (const entry of entries) {
      if (entry.type === "info") {
        const log = entry.value;
        text += `[${formatTimestamp(
          log.timestamp
        )}] [${log.level.toUpperCase()}] ${log.label}\n`;
        if (log.data !== undefined) {
          text += `${stringify(sanitizeBody(log.data))}\n`;
        }
        text = appendError(text, log.error);
        text += "\n";
        continue;
      }

      const http = entry.value;
      const view = entry.view;
      const showRequest = view !== "response";
      const showResponse = view !== "request";

      if (view === "response") {
        text += `[${formatTimestamp(entry.timestamp)}] Response to: ${
          http.request.method
        } ${sanitizeUrl(http.request.url)}\n`;
      } else {
        text += `[${formatTimestamp(http.timestamp)}] Request: ${
          http.request.method
        } ${sanitizeUrl(http.request.url)}\n`;
      }
      if (showResponse && http.duration !== undefined) {
        text += `Duration: ${http.duration}ms\n`;
      }
      if (showResponse && http.response) {
        text += `Status: ${http.response.status} ${http.response.statusText}\n`;
      }
      if (view === "request" && http.response) {
        const receivedStep = getXAAReceivedStepForRequest(http.step);
        text += `Response: recorded under [${receivedStep}]\n`;
      }
      if (showRequest && Object.keys(http.request.headers).length > 0) {
        text += `\nRequest Headers:\n${stringify(
          sanitizeHeaders(http.request.headers)
        )}\n`;
      }
      if (showRequest && http.request.body !== undefined) {
        text += `\nRequest Body:\n${stringify(
          sanitizeBody(http.request.body)
        )}\n`;
      }
      if (
        showResponse &&
        http.response &&
        Object.keys(http.response.headers).length > 0
      ) {
        text += `\nResponse Headers:\n${stringify(
          sanitizeHeaders(http.response.headers)
        )}\n`;
      }
      if (showResponse && http.response?.body !== undefined) {
        text += `\nResponse Body:\n${stringify(
          sanitizeBody(http.response.body)
        )}\n`;
      }
      text = appendError(text, http.error);
      text += "\n";
    }
  }

  return text;
}
