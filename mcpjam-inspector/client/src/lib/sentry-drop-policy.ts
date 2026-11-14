import type { ErrorEvent, EventHint } from "@sentry/core";
import { isInjectedScriptException } from "../../../shared/injected-script-frames";
import {
  isAuthorizationRefusal,
  isSessionRevokedError,
  isUnauthenticatedError,
} from "./authorization-refusal";
import {
  createQueryRequestCache,
  queryFailureDetails,
  queryFailureTags,
} from "./convex-query-diagnostics";

/** Decide only whether to report while the original exception is still available. */
export function createSentryDropPolicy(origin: string | undefined) {
  const duplicate = createQueryRequestCache();
  return (event: ErrorEvent, hint: EventHint): boolean => {
    if (event.type !== undefined) return false;
    if (
      isAuthorizationRefusal(hint.originalException) ||
      isSessionRevokedError(hint.originalException) ||
      isUnauthenticatedError(hint.originalException)
    )
      return true;
    const values = event.exception?.values ?? [];
    const stacks = values.map((value) => {
      const frames = value.stacktrace?.frames ?? [];
      return frames.length === 1 && frames[0]?.function === "?"
        ? []
        : frames.map((frame) => frame.filename);
    });
    if (origin && isInjectedScriptException(stacks, origin)) return true;
    const query = values.find((value) =>
      queryFailureDetails(value.value ?? ""),
    );
    const details = queryFailureDetails(query?.value ?? "");
    const tags = queryFailureTags(query?.value ?? "");
    const backend =
      typeof event.tags?.convex_backend === "string"
        ? event.tags.convex_backend
        : tags?.convex_backend;
    return !!details && duplicate(backend, details.requestId);
  };
}
