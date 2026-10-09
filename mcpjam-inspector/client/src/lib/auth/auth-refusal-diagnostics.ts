import { authCorrelationId } from "./correlation-id";
import * as Sentry from "@sentry/react";
import { queryFailureDetails } from "../convex-query-diagnostics";

type Context = {
  mode: "guest" | "workos" | "unknown";
  authenticated: boolean;
  ready: boolean;
  epoch: number;
  recoveryId: string | null;
  blocked: boolean;
};
type Refusal = "unauthenticated" | "session_revoked";
const initial: Context = {
  mode: "unknown",
  authenticated: false,
  ready: false,
  epoch: 0,
  recoveryId: null,
  blocked: false,
};

export function createAuthRefusalDiagnostics(
  send: (data: Record<string, unknown>) => void,
) {
  let context = { ...initial };
  const tabId = authCorrelationId();
  let episode: {
    id: string;
    startedAt: number;
    initial: Context;
    failures: {
      kind: Refusal;
      requestId?: string;
      functionName: string;
      backend?: string;
    }[];
    transitions: { at: number; state: Context }[];
    sent: boolean;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (outcome: "recovered" | "unresolved" | "page_hidden") => {
    if (!episode || episode.sent) return;
    episode.sent = true;
    clearTimeout(timer);
    try {
      send({ ...episode, tabId, outcome, finishedAt: Date.now() });
    } catch {
      /* Diagnostics cannot affect auth. */
    }
  };
  return {
    update(next: Partial<Context>) {
      const previous = context;
      context = { ...context, ...next };
      if (!episode) return;
      if (
        !episode.sent &&
        episode.transitions.length < 20 &&
        JSON.stringify(previous) !== JSON.stringify(context)
      ) {
        episode.transitions.push({ at: Date.now(), state: { ...context } });
      }
      if (
        context.ready &&
        context.authenticated &&
        !context.blocked &&
        (context.epoch > episode.initial.epoch || !previous.ready)
      ) {
        flush("recovered");
        episode = null;
      }
    },
    record(
      kind: Refusal,
      message: string,
      functionName: string,
      backend?: string,
    ) {
      if (!episode) {
        episode = {
          id: authCorrelationId(),
          startedAt: Date.now(),
          initial: { ...context },
          failures: [],
          transitions: [],
          sent: false,
        };
        timer = setTimeout(() => flush("unresolved"), 15_000);
      }
      if (episode.sent || episode.failures.length >= 20) return;
      const requestId = queryFailureDetails(message)?.requestId;
      if (!/^[\w/.-]+:[\w.-]+$/.test(functionName)) return;
      if (
        episode.failures.some(
          (f) =>
            f.requestId === requestId &&
            f.functionName === functionName &&
            f.kind === kind,
        )
      )
        return;
      episode.failures.push({ kind, requestId, functionName, backend });
    },
    flush: () => flush("page_hidden"),
    dispose() {
      clearTimeout(timer);
      episode = null;
      context = { ...initial };
    },
  };
}

export const authRefusalDiagnostics = createAuthRefusalDiagnostics((data) => {
  const first = (
    data.failures as { requestId?: string; backend?: string }[]
  )[0];
  Sentry.captureMessage("Convex auth refusal diagnostic", {
    level: "info",
    tags: {
      source: "convex_auth_refusal",
      auth_refusal_id: String(data.id),
      ...(first?.requestId ? { request_id: first.requestId } : {}),
      ...(first?.backend ? { convex_backend: first.backend } : {}),
    },
    contexts: {
      auth_refusal: {
        ...data,
        version:
          typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
        build: typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "unknown",
        surface:
          typeof __BUILD_SURFACE__ === "string" ? __BUILD_SURFACE__ : "unknown",
      },
    },
  });
});
