import type { ErrorEvent, EventHint } from "@sentry/react";
import { isAuthorizationRefusal } from "./authorization-refusal";

let backendHostname: string | undefined;

export function configureConvexQueryDiagnostics(url: string): void {
  try {
    backendHostname = new URL(url).hostname;
  } catch {
    backendHostname = undefined;
  }
}

/** Keep route context, never query strings, hash fragments or share credentials. */
export function queryPageLocation(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    const path = url.pathname
      .replace(
        /(\/(?:results|conformance\/shared|evals\/shared|organizations)\/)[^/]+/g,
        "$1[redacted]",
      )
      .replace(/(\/(?:user-testing|chatbox)\/[^/]+\/)[^/]+/g, "$1[redacted]");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function queryFailureDetails(message: string) {
  const match = /^\[CONVEX Q\(([\w/.-]+:[\w.-]+)\)\]/.exec(message);
  if (!match) return undefined;
  const requestId = /\[Request ID: ([a-f\d]+)\]/i.exec(message)?.[1];
  // Validation errors can embed argument values; keep only the protocol prefix.
  const safeMessage = `${match[0]}${requestId ? ` [Request ID: ${requestId}]` : ""} ${/\bServer Error\b/.test(message) ? "Server Error" : "Query failed"}`;
  return { functionName: match[1], requestId, safeMessage };
}

export function queryFailureTags(
  message: string,
): Record<string, string> | undefined {
  const details = queryFailureDetails(message);
  if (!details) return undefined;
  return {
    convex_function: details.functionName,
    ...(details.requestId ? { request_id: details.requestId } : {}),
    ...(backendHostname ? { convex_backend: backendHostname } : {}),
  };
}

export function safeQueryError(error: Error): Error {
  const details = queryFailureDetails(error.message);
  if (!details) return error;
  const safe = new Error(details.safeMessage);
  safe.name = error.name;
  // Preserve the original frames without retaining the original message/data.
  if (error.stack) {
    const frames = error.stack
      .split("\n")
      .filter((line) =>
        /^(\s+at |[^@]*@(?:https?|file|webpack|vite):)/.test(line),
      );
    safe.stack = `${safe.name}: ${safe.message}\n${frames.join("\n")}`;
  }
  return safe;
}

export function createQueryRequestCache(limit = 500) {
  const seen = new Set<string>();
  return (
    hostname: string | undefined,
    requestId: string | undefined,
  ): boolean => {
    if (!hostname || !requestId) return false;
    const key = `${hostname}:${requestId}`;
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return false;
  };
}

/** One cache per Sentry client session; no request-ID fingerprinting. */
export function createConvexQueryEventProcessor(limit = 500) {
  const duplicate = createQueryRequestCache(limit);
  return (event: ErrorEvent, hint: EventHint = {}): ErrorEvent | null => {
    try {
      const values = event.exception?.values;
      const exception = values?.find((value) =>
        queryFailureDetails(value.value ?? ""),
      );
      const details = queryFailureDetails(exception?.value ?? "");
      if (!details) return event;
      if (isAuthorizationRefusal(hint.originalException)) return null;
      const tags = queryFailureTags(exception!.value!)!;
      const hostname =
        typeof event.tags?.convex_backend === "string"
          ? event.tags.convex_backend
          : tags.convex_backend;
      if (duplicate(hostname, details.requestId)) return null;

      exception!.value = details.safeMessage;
      if (event.message) event.message = details.safeMessage;
      event.tags = {
        ...event.tags,
        ...tags,
        ...(hostname ? { convex_backend: hostname } : {}),
      };
      const page = queryPageLocation(
        (typeof event.extra?.page_location === "string"
          ? event.extra.page_location
          : undefined) ??
          event.request?.url ??
          (typeof window !== "undefined" ? window.location.href : ""),
      );
      // SDK request headers, breadcrumbs and exception data may contain URLs,
      // arguments, or credentials. Only retain explicitly safe query context.
      event.request = page ? { url: page } : undefined;
      event.breadcrumbs = undefined;
      event.extra = {
        ...(typeof event.extra?.boundary === "string"
          ? { boundary: event.extra.boundary }
          : {}),
        ...(typeof event.extra?.componentStack === "string"
          ? { componentStack: event.extra.componentStack }
          : {}),
        ...(page ? { page_location: page } : {}),
      };
      for (const value of values ?? []) {
        if (value !== exception && value.value) {
          value.value =
            queryFailureDetails(value.value)?.safeMessage ??
            "Query failure cause";
        }
        if (value.stacktrace) {
          for (const frame of value.stacktrace.frames ?? []) delete frame.vars;
        }
      }
      if (event.transaction?.includes("/"))
        event.transaction = queryPageLocation(
          `https://route.invalid${event.transaction}`,
        )?.replace("https://route.invalid", "");
      return event;
    } catch {
      // A telemetry failure must not affect the application.
      return null;
    }
  };
}
