import { getXAAStepInfo, getXAAStepIndex } from "./step-metadata";
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

const stringify = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const appendError = (
  text: string,
  error: XAAInfoLogEntry["error"] | XAAHttpHistoryEntry["error"],
) => {
  if (!error) return text;
  text += `ERROR: ${error.message}\n`;
  if (
    error.details &&
    typeof error.details === "object" &&
    "stack" in error.details &&
    typeof error.details.stack === "string"
  ) {
    text += `Stack: ${error.details.stack}\n`;
  }
  return text;
};

export function generateXAAFlowText(
  flowState: XAAFlowState,
  summary: XAAFlowCopySummary,
): string {
  let text = "=== XAA Debugger - Flow ===\n\n";
  text += `Server URL: ${
    summary.serverUrl || flowState.serverUrl || "Not set"
  }\n`;
  text += `Authorization Server: ${
    summary.authzServerIssuer ||
    flowState.authzServerIssuer ||
    "Discovered at runtime"
  }\n`;
  text += `Client ID: ${summary.clientId || flowState.clientId || "Not set"}\n`;
  text += `Scope: ${summary.scope || flowState.scope || "Not set"}\n`;
  text += `Test mode: ${flowState.negativeTestMode}\n`;
  text += `Current step: ${flowState.currentStep}\n`;
  if (flowState.error) text += `ERROR: ${flowState.error}\n`;
  text += "\n";

  type TimelineEntry =
    | { type: "info"; timestamp: number; value: XAAInfoLogEntry }
    | { type: "http"; timestamp: number; value: XAAHttpHistoryEntry };

  const byStep = new Map<XAAFlowStep, TimelineEntry[]>();
  const add = (step: XAAFlowStep, entry: TimelineEntry) => {
    const entries = byStep.get(step) ?? [];
    entries.push(entry);
    byStep.set(step, entries);
  };

  for (const entry of flowState.infoLogs ?? []) {
    add(entry.step, { type: "info", timestamp: entry.timestamp, value: entry });
  }
  for (const entry of flowState.httpHistory ?? []) {
    add(entry.step, { type: "http", timestamp: entry.timestamp, value: entry });
  }

  const steps = Array.from(byStep.keys()).sort(
    (a, b) => getXAAStepIndex(a) - getXAAStepIndex(b),
  );
  if (steps.length === 0) return `${text}No activity yet.\n`;

  for (const step of steps) {
    const stepInfo = getXAAStepInfo(step);
    text += `${"=".repeat(60)}\n`;
    text += `${stepInfo.title} [${step}]\n`;
    text += `${"=".repeat(60)}\n`;
    text += `${stepInfo.summary}\n\n`;

    const entries = byStep.get(step)!.sort((a, b) => a.timestamp - b.timestamp);
    for (const entry of entries) {
      if (entry.type === "info") {
        const log = entry.value;
        text += `[${formatTimestamp(
          log.timestamp,
        )}] [${log.level.toUpperCase()}] ${log.label}\n`;
        if (log.data !== undefined) text += `${stringify(log.data)}\n`;
        text = appendError(text, log.error);
        text += "\n";
        continue;
      }

      const http = entry.value;
      text += `[${formatTimestamp(http.timestamp)}] ${http.request.method} ${
        http.request.url
      }\n`;
      if (http.duration !== undefined) text += `Duration: ${http.duration}ms\n`;
      if (http.response) {
        text += `Status: ${http.response.status} ${http.response.statusText}\n`;
      }
      if (Object.keys(http.request.headers).length > 0) {
        text += `\nRequest Headers:\n${stringify(http.request.headers)}\n`;
      }
      if (http.request.body !== undefined) {
        text += `\nRequest Body:\n${stringify(http.request.body)}\n`;
      }
      if (http.response && Object.keys(http.response.headers).length > 0) {
        text += `\nResponse Headers:\n${stringify(http.response.headers)}\n`;
      }
      if (http.response?.body !== undefined) {
        text += `\nResponse Body:\n${stringify(http.response.body)}\n`;
      }
      text = appendError(text, http.error);
      text += "\n";
    }
  }

  return text;
}
