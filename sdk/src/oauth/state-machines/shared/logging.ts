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
    (decision.strictClientCompatible && decision.rfc9728Compliant)
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
      "RFC 9728 compliant": decision.rfc9728Compliant,
      ...(decision.rfc9728Reason
        ? { "RFC 9728 reason": decision.rfc9728Reason }
        : {}),
      Note:
        decision.status === "valid"
          ? "The flow will send this interoperability-safe resource, but it is not RFC 9728 compliant and strict conformance surfaces will reject it."
          : "The debugger will send the advertised resource as-is so you can observe real behavior, but MCP clients — including MCPJam's Quick OAuth and the official MCP SDK — validate it against the server URL and will refuse to connect.",
    },
    { level: "warning" },
  );
}

// The server answered the unauthenticated probe with a Bearer challenge on a
// status MCP does not allow there (a 403 instead of 401). Same warn-mode
// bargain as above: the debugger continues discovery off the challenge so users
// can observe real behavior, but must say the status is non-compliant, because
// clients keying on the status alone will never start OAuth against it.
export function addChallengeStatusWarning(
  state: OAuthFlowState,
  infoLogs: Array<InfoLogEntry> | undefined,
  step: OAuthFlowStep,
  response: { status: number; statusText?: string },
): Array<InfoLogEntry> {
  return addInfoLog(
    { ...state, infoLogs },
    step,
    "non-compliant-challenge-status",
    "Non-compliant challenge status",
    {
      Received: `${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      }`,
      Expected: "401 Unauthorized",
      Note: "The server sent a WWW-Authenticate Bearer challenge, so the debugger continues OAuth discovery from it. MCP requires 401 here — clients that decide to authenticate from the status code alone, including the official MCP SDK, will not start OAuth against this server.",
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
