import type {
  HttpHistoryEntry,
  InfoLogEntry,
  InfoLogLevel,
  LogErrorDetails,
  OAuthFlowState,
  OAuthFlowStep,
} from "../types.js";
import type { ResourceIndicatorDecision } from "../../resource-policy.js";

export interface AddInfoLogOptions {
  level?: InfoLogLevel;
  error?: LogErrorDetails;
}

export function addInfoLog(
  state: OAuthFlowState,
  step: OAuthFlowStep,
  id: string,
  label: string,
  data: any,
  options: AddInfoLogOptions = {},
): Array<InfoLogEntry> {
  const { level = "info", error } = options;

  return [
    ...(state.infoLogs || []),
    {
      id,
      step,
      label,
      data,
      timestamp: Date.now(),
      level,
      error,
    },
  ];
}

// Warn-mode surfaces (the debugger) proceed with a broken or
// strict-incompatible advertised resource so users can observe real behavior
// — but must say so. No-op when no PRM resource was advertised (server
// fallback) or the decision is fully valid and strict-compatible.
export function addResourceMismatchWarning(
  state: OAuthFlowState,
  infoLogs: Array<InfoLogEntry>,
  decision: ResourceIndicatorDecision | undefined,
  serverUrl: string | undefined,
): Array<InfoLogEntry> {
  if (
    !decision ||
    decision.source !== "prm" ||
    decision.strictClientCompatible
  ) {
    return infoLogs;
  }

  return addInfoLog(
    { ...state, infoLogs },
    "received_resource_metadata",
    "resource-identifier-mismatch",
    "Resource identifier mismatch",
    {
      "Advertised resource": decision.value,
      "Server URL": serverUrl,
      Status: decision.status,
      Reason: decision.reason,
      Note:
        decision.status === "valid"
          ? "The flow will send the advertised resource, but clients enforcing the official MCP SDK's strict path-prefix binding may refuse to connect to this server."
          : "The debugger will send the advertised resource as-is (RFC 8707) so you can observe real behavior, but MCP clients — including MCPJam's Quick OAuth and the official MCP SDK — validate it against the server URL and will refuse to connect.",
    },
    { level: "warning" },
  );
}

export function toLogErrorDetails(error: unknown): LogErrorDetails {
  if (error instanceof Error) {
    return {
      message: error.message,
      details: {
        name: error.name,
        stack: error.stack,
      },
    };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return {
    message: "Unexpected error",
    details: error,
  };
}

export function markLatestHttpEntryAsError(
  history: OAuthFlowState["httpHistory"],
  error: LogErrorDetails,
): Array<HttpHistoryEntry> | undefined {
  if (!history || history.length === 0) {
    return history || undefined;
  }

  const updatedHistory = [...history];
  const lastEntry = { ...updatedHistory[updatedHistory.length - 1] };

  updatedHistory[updatedHistory.length - 1] = {
    ...lastEntry,
    error,
    duration:
      lastEntry.duration !== undefined
        ? lastEntry.duration
        : Date.now() - lastEntry.timestamp,
  };

  return updatedHistory;
}
