import type {
  HttpHistoryEntry,
  InfoLogEntry,
  InfoLogLevel,
  LogErrorDetails,
  OAuthFlowState,
  OAuthFlowStep,
} from "../types.js";

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
