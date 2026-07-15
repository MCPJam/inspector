import {
  getStepInfo,
  getStepIndex,
  type OAuthFlowState,
  type OAuthFlowStep,
} from "@mcpjam/sdk/browser";
import { Circle, CheckCircle2 } from "lucide-react";
import type { HttpEntryView } from "@/lib/http-entry-views";
import { getOAuthReceivedStepForRequest } from "@/lib/oauth/step-pairing";

interface StepEntry {
  type: "info" | "http";
  log?: NonNullable<OAuthFlowState["infoLogs"]>[number];
  entry?: NonNullable<OAuthFlowState["httpHistory"]>[number];
  /** Which half of the exchange this item presents (split display); absent
   * means the classic combined entry. */
  view?: HttpEntryView;
  /** Display timestamp for split items (response items sort at arrival). */
  timestamp?: number;
}

interface StepGroup {
  step: OAuthFlowStep;
  entries: StepEntry[];
  firstTimestamp: number;
}

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString();

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
  "id_token",
  "password",
  "refresh_token",
  "set_cookie",
  "state",
  "subject_token",
  "token",
]);

const normalizeSensitiveKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();

const isSensitiveField = (key: string) =>
  SENSITIVE_FIELDS.has(normalizeSensitiveKey(key));

const isSensitiveContainerKey = (key: string) => {
  const normalized = normalizeSensitiveKey(key);
  return (
    SENSITIVE_FIELDS.has(normalized) ||
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(
      normalized,
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
  "gi",
);

function sanitizeCopyString(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return sanitizeCopyValue(JSON.parse(trimmed));
    } catch {
      // Fall through to form/text redaction.
    }
  }

  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(sensitiveStringAssignmentPattern, `$1${REDACTED}`);
}

function sanitizeCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCopyValue);
  if (typeof value === "string") return sanitizeCopyString(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      isSensitiveField(key) ? REDACTED : sanitizeCopyValue(entryValue),
    ]),
  );
}

function sanitizeCopyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveContainerKey(key)
        ? REDACTED
        : stringifyCopyValue(value),
    ]),
  );
}

function sanitizeCopyUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveContainerKey(key)) url.searchParams.set(key, REDACTED);
    }
    if (url.hash) url.hash = `#${REDACTED}`;
    return url.toString();
  } catch {
    return String(sanitizeCopyString(rawUrl));
  }
}

const stringifyCopyValue = (value: unknown) => {
  const sanitized = sanitizeCopyValue(value);
  return typeof sanitized === "string"
    ? sanitized
    : JSON.stringify(sanitized, null, 2);
};

const getErrorStack = (
  error:
    | NonNullable<OAuthFlowState["infoLogs"]>[number]["error"]
    | NonNullable<OAuthFlowState["httpHistory"]>[number]["error"]
    | undefined,
): string | undefined => {
  if (
    error?.details &&
    typeof error.details === "object" &&
    error.details !== null &&
    "stack" in error.details &&
    typeof error.details.stack === "string"
  ) {
    return error.details.stack;
  }

  return undefined;
};

const getStatusIcon = (step: OAuthFlowStep, currentStepIndex: number) => {
  const index = getStepIndex(step);

  if (index === Number.MAX_SAFE_INTEGER) {
    return {
      icon: Circle,
      className: "h-4 w-4 text-muted-foreground",
      label: "Pending",
    };
  }

  if (index < currentStepIndex) {
    return {
      icon: CheckCircle2,
      className: "h-4 w-4 text-green-600 dark:text-green-400",
      label: "Complete",
    };
  }

  if (index === currentStepIndex) {
    return {
      icon: CheckCircle2,
      className: "h-4 w-4 text-green-600 dark:text-green-400",
      label: "Complete",
    };
  }

  return {
    icon: Circle,
    className: "h-4 w-4 text-muted-foreground",
    label: "Pending",
  };
};

export function generateGuideText(
  oauthFlowState: OAuthFlowState,
  groups: StepGroup[],
): string {
  let text = "=== OAuth Debugger - Guide View ===\n\n";

  if (oauthFlowState.error) {
    text += `ERROR: ${stringifyCopyValue(oauthFlowState.error)}\n\n`;
  }

  if (groups.length === 0) {
    text += "No activity yet.\n";
    return text;
  }

  const currentStepIndex = getStepIndex(oauthFlowState.currentStep);

  groups.forEach((group, groupIndex) => {
    const info = getStepInfo(group.step);
    const stepNumber = groupIndex + 1;
    const statusInfo = getStatusIcon(group.step, currentStepIndex);

    text += `\n${"=".repeat(60)}\n`;
    text += `${stepNumber}. ${info.title} [${statusInfo.label}]\n`;
    text += `${"=".repeat(60)}\n`;
    text += `${info.summary}\n\n`;

    // Add teachable moments
    if (info.teachableMoments && info.teachableMoments.length > 0) {
      text += "What to pay attention to:\n";
      info.teachableMoments.forEach((moment) => {
        text += `  - ${moment}\n`;
      });
      text += "\n";
    }

    // Add tips
    if (info.tips && info.tips.length > 0) {
      text += "Tips:\n";
      info.tips.forEach((tip) => {
        text += `  - ${tip}\n`;
      });
      text += "\n";
    }

    // Add entries
    group.entries.forEach((entry) => {
      if (entry.type === "info" && entry.log) {
        const log = entry.log;
        text += `[${formatTimestamp(log.timestamp)}] ${log.label || "Info"}\n`;
        if (log.data) {
          text += `${stringifyCopyValue(log.data)}\n`;
        }
        if (log.error) {
          text += `ERROR: ${stringifyCopyValue(log.error.message)}\n`;
        }
        text += "\n";
      } else if (entry.type === "http" && entry.entry) {
        const httpEntry = entry.entry;
        // Mirrors the Guide tab's split: request halves print under the
        // request step, response halves under the paired received step.
        const view = entry.view ?? "full";
        const showRequest = view !== "response";
        const showResponse = view !== "request";

        if (view === "response") {
          text += `[${formatTimestamp(entry.timestamp ?? httpEntry.timestamp)}] Response to ${httpEntry.request.method} ${sanitizeCopyUrl(httpEntry.request.url)}\n`;
        } else {
          text += `[${formatTimestamp(httpEntry.timestamp)}] ${httpEntry.request.method} ${sanitizeCopyUrl(httpEntry.request.url)}\n`;
        }

        if (showResponse && httpEntry.duration) {
          text += `Duration: ${httpEntry.duration}ms\n`;
        }

        if (showResponse && httpEntry.response?.status) {
          text += `Status: ${httpEntry.response.status} ${httpEntry.response.statusText || ""}\n`;
        }

        if (view === "request" && httpEntry.response) {
          text += `Response: recorded under [${getOAuthReceivedStepForRequest(
            httpEntry.step,
          )}]\n`;
        }

        // Request details
        if (
          showRequest &&
          httpEntry.request.headers &&
          Object.keys(httpEntry.request.headers).length > 0
        ) {
          text += "\nRequest Headers:\n";
          text += `${JSON.stringify(
            sanitizeCopyHeaders(httpEntry.request.headers),
            null,
            2,
          )}\n`;
        }

        if (showRequest && httpEntry.request.body) {
          text += "\nRequest Body:\n";
          text += `${stringifyCopyValue(httpEntry.request.body)}\n`;
        }

        // Response details
        if (
          showResponse &&
          httpEntry.response?.headers &&
          Object.keys(httpEntry.response.headers).length > 0
        ) {
          text += "\nResponse Headers:\n";
          text += `${JSON.stringify(
            sanitizeCopyHeaders(httpEntry.response.headers),
            null,
            2,
          )}\n`;
        }

        if (showResponse && httpEntry.response?.body) {
          text += "\nResponse Body:\n";
          text += `${stringifyCopyValue(httpEntry.response.body)}\n`;
        }

        if (httpEntry.error) {
          text += `\nERROR: ${stringifyCopyValue(httpEntry.error.message)}\n`;
          const stack = getErrorStack(httpEntry.error);
          if (stack) {
            text += `Stack: ${stringifyCopyValue(stack)}\n`;
          }
        }
        text += "\n";
      }
    });
  });

  return text;
}

export function generateRawText(
  _oauthFlowState: OAuthFlowState,
  timelineEntries: Array<
    | {
        type: "info";
        timestamp: number;
        log: NonNullable<OAuthFlowState["infoLogs"]>[number];
        key: string;
      }
    | {
        type: "http";
        timestamp: number;
        entry: NonNullable<OAuthFlowState["httpHistory"]>[number];
        /** Display step/view; omitted by older callers to preserve full view. */
        step?: OAuthFlowStep;
        view?: HttpEntryView;
        key: string;
      }
  >,
): string {
  let text = "=== OAuth Debugger - Raw Logs ===\n\n";

  if (timelineEntries.length === 0) {
    text += "No activity yet.\n";
    return text;
  }

  timelineEntries.forEach((entry) => {
    if (entry.type === "info") {
      const log = entry.log;
      const level = log.level ?? "info";
      text += `[${formatTimestamp(log.timestamp)}] [${level.toUpperCase()}] ${log.step}\n`;
      text += `${log.label || "Info"}\n`;
      if (log.data) {
        text += `${stringifyCopyValue(log.data)}\n`;
      }
      if (log.error) {
        text += `ERROR: ${stringifyCopyValue(log.error.message)}\n`;
        const stack = getErrorStack(log.error);
        if (stack) {
          text += `Stack: ${stringifyCopyValue(stack)}\n`;
        }
      }
      text += "\n";
    } else {
      const httpEntry = entry.entry;
      const view = entry.view ?? "full";
      const displayStep = entry.step ?? httpEntry.step;
      const showRequest = view !== "response";
      const showResponse = view !== "request";
      const status = httpEntry.response?.status;
      const statusLabel =
        view === "request" && status !== undefined
          ? "request sent"
          : status !== undefined
          ? `${status}${httpEntry.response?.statusText ? ` ${httpEntry.response?.statusText}` : ""}`
          : "pending";

      text += `[${formatTimestamp(entry.timestamp)}] [${httpEntry.request.method}] [${statusLabel}] ${displayStep}\n`;
      text += `URL: ${sanitizeCopyUrl(httpEntry.request.url)}\n`;

      if (showResponse && httpEntry.duration) {
        text += `Duration: ${httpEntry.duration}ms\n`;
      }

      // Request details
      if (showRequest &&
        httpEntry.request.headers &&
        Object.keys(httpEntry.request.headers).length > 0
      ) {
        text += "\nRequest Headers:\n";
        text += `${JSON.stringify(
          sanitizeCopyHeaders(httpEntry.request.headers),
          null,
          2,
        )}\n`;
      }

      if (showRequest && httpEntry.request.body) {
        text += "\nRequest Body:\n";
        text += `${stringifyCopyValue(httpEntry.request.body)}\n`;
      }

      if (view === "request" && httpEntry.response) {
        text += `Response: recorded under [${getOAuthReceivedStepForRequest(
          httpEntry.step,
        )}]\n`;
      }

      // Response details
      if (
        showResponse &&
        httpEntry.response?.headers &&
        Object.keys(httpEntry.response.headers).length > 0
      ) {
        text += "\nResponse Headers:\n";
        text += `${JSON.stringify(
          sanitizeCopyHeaders(httpEntry.response.headers),
          null,
          2,
        )}\n`;
      }

      if (showResponse && httpEntry.response?.body) {
        text += "\nResponse Body:\n";
        text += `${stringifyCopyValue(httpEntry.response.body)}\n`;
      }

      if (httpEntry.error) {
        text += `\nERROR: ${stringifyCopyValue(httpEntry.error.message)}\n`;
        const stack = getErrorStack(httpEntry.error);
        if (stack) {
          text += `Stack: ${stringifyCopyValue(stack)}\n`;
        }
      }
      text += "\n";
    }
  });

  return text;
}
