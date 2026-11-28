/**
 * Families 11, 12 and 13: Completion, pagination and caching, and progress,
 * cancellation and logging.
 */

import type {
  DeclaredSurface,
  FeatureDefinition,
  ListCacheHints,
} from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import {
  absent,
  declaresCapability,
  isComplete,
  lifecycle,
  listDetail,
  present,
  unknown,
  type DeclaredRule,
} from "./rules.js";

const COMPLETION = "server/utilities/completion";
const PAGINATION = "server/utilities/pagination";
const CACHING = "server/utilities/caching";
const LOGGING = "server/utilities/logging";
const MODERN = lifecycle({ introduced: "2026-07-28" });

const LIST_METHODS = {
  tools: "tools/list",
  resources: "resources/list",
  resourceTemplates: "resources/templates/list",
  prompts: "prompts/list",
} as const;
type HintedList = keyof typeof LIST_METHODS;
const HINTED_LISTS: readonly HintedList[] = [
  "tools",
  "resources",
  "resourceTemplates",
  "prompts",
];

/** Lists whose saved hints pass `test`, by method name. */
function listsWith(
  hints: DeclaredSurface["listHints"],
  test: (entry: ListCacheHints) => boolean
): string[] {
  return HINTED_LISTS.filter((list) => {
    const entry = hints[list];
    return entry !== undefined && test(entry);
  }).map((list) => LIST_METHODS[list]);
}

/** ttlMs and cacheScope are required on every complete cacheable result. */
function cacheHint(test: (entry: ListCacheHints) => boolean): DeclaredRule {
  return (surface) => {
    const lists = listsWith(surface.listHints, test);
    return lists.length > 0
      ? present("advertised", {
          count: lists.length,
          detail: `On ${listDetail(lists)}.`,
        })
      : absent(["listHints"]);
  };
}

const pagination: DeclaredRule = (surface) => {
  const paged = listsWith(
    surface.listHints,
    (entry) => typeof entry.pages === "number" && entry.pages > 1
  );
  if (paged.length > 0) {
    return present("detected", {
      count: paged.length,
      detail: `Paged ${listDetail(paged)}.`,
    });
  }
  return isComplete(surface, ["listHints"])
    ? unknown("Every list fit on one page, so pagination did not come up.")
    : null;
};

export const COMPLETION_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "completion.capability",
    family: "completion",
    name: "completions capability",
    summary:
      "Declares that the server suggests values for prompt and resource template arguments.",
    howTo:
      "Declare completions and answer completion/complete. MCP SDKs do this when you register a completer.",
    owner: "server",
    spec: coreSpec("2026-07-28", COMPLETION, "capabilities"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: declaresCapability("completions"),
    },
  },
  {
    id: "completion.prompt-ref",
    family: "completion",
    parent: "completion.capability",
    name: "Prompt argument completion (ref/prompt)",
    summary: "Suggests values for a prompt argument as the user types.",
    howTo:
      "Answer completion/complete for ref/prompt with matching values.",
    owner: "server",
    spec: coreSpec("2026-07-28", COMPLETION, "requesting-completions"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "completion.resource-ref",
    family: "completion",
    parent: "completion.capability",
    name: "Template argument completion (ref/resource)",
    summary: "Suggests values for a resource template variable.",
    howTo:
      "Answer completion/complete for ref/resource with values for the template variable.",
    owner: "server",
    spec: coreSpec("2026-07-28", COMPLETION, "reference-types"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "completion.context-arguments",
    family: "completion",
    parent: "completion.capability",
    name: "Completion context",
    summary:
      "Values the user already entered arrive in context.arguments, so suggestions can depend on them.",
    howTo:
      "Read context.arguments in your completer to narrow its suggestions.",
    owner: "server",
    spec: coreSpec("2026-07-28", COMPLETION, "requesting-completions"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: { primary: "checked" },
  },
  {
    id: "completion.result-shape",
    family: "completion",
    parent: "completion.capability",
    name: "Completion results",
    summary:
      "Up to 100 values, with total and hasMore when more matches exist.",
    howTo:
      "Return at most 100 values, and set total and hasMore when you cut the list short.",
    owner: "server",
    spec: coreSpec("2026-07-28", COMPLETION, "completion-results"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "checked" },
  },
];

export const PAGINATION_CACHING_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "pagination.cursor",
    family: "pagination-caching",
    name: "Pagination (cursor and nextCursor)",
    summary:
      "Long lists come back in pages, and the client follows nextCursor for the rest.",
    howTo:
      "Return nextCursor when a list has more items, and accept it as cursor on the next call.",
    owner: "server",
    spec: coreSpec("2026-07-28", PAGINATION),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "declared", observable: true, declared: pagination },
  },
  {
    id: "pagination.invalid-cursor",
    family: "pagination-caching",
    name: "Invalid cursor error (-32602)",
    summary:
      "A cursor the server did not issue gets a -32602 error instead of a wrong page.",
    howTo: "Validate cursors and return -32602 for any you did not issue.",
    owner: "server",
    spec: coreSpec("2026-07-28", PAGINATION, "error-handling"),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "caching.ttl-ms",
    family: "pagination-caching",
    name: "Cache lifetime (ttlMs)",
    summary:
      "Tells clients how long a list or read result stays fresh, so they can skip repeat requests.",
    howTo:
      "Return ttlMs on server/discover, list results and resources/read. 0 means do not reuse the result.",
    owner: "server",
    spec: coreSpec("2026-07-28", CACHING, "cacheable-results"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: {
      primary: "declared",
      declared: cacheHint(
        (entry) =>
          typeof entry.ttlMs === "number" &&
          Number.isFinite(entry.ttlMs) &&
          entry.ttlMs >= 0
      ),
    },
  },
  {
    id: "caching.cache-scope",
    family: "pagination-caching",
    name: "Cache scope (cacheScope)",
    summary:
      "Says whether a cached result can be shared across users (public) or reused for one caller (private).",
    howTo:
      "Return cacheScope private when a result depends on the caller's authorization, and public otherwise.",
    owner: "server",
    spec: coreSpec("2026-07-28", CACHING, "cacheable-results"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: {
      primary: "declared",
      declared: cacheHint(
        (entry) =>
          entry.cacheScope === "public" || entry.cacheScope === "private"
      ),
    },
  },
  {
    id: "caching.scope-correctness",
    family: "pagination-caching",
    name: "Private scope for per-user results",
    summary:
      "Results that vary by user or authorization are marked private, so shared caches never mix them up.",
    howTo: "Mark every list or read that depends on the caller as private.",
    owner: "server",
    spec: coreSpec("2026-07-28", CACHING, "cacheable-model"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "observed" },
  },
  {
    id: "caching.no-hints-on-input-required",
    family: "pagination-caching",
    name: "No cache hints on input_required",
    summary:
      "Results that pause for input carry no ttlMs or cacheScope, and their retries are never cached.",
    howTo: "Leave ttlMs and cacheScope off input_required results.",
    owner: "server",
    spec: coreSpec("2026-07-28", CACHING, "cache-key"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "observed", observable: true },
  },
];

export const REQUEST_CONTROL_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "request-control.progress",
    family: "request-control",
    name: "Progress notifications",
    summary:
      "Long requests report progress, with a total and a message, against the client's progressToken.",
    howTo:
      "Send notifications/progress with the request's progressToken while a long tool runs. Call the tool in Playground to see it.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/patterns/progress"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "request-control.cancellation",
    family: "request-control",
    name: "Cancellation",
    summary:
      "The client cancels a request in flight and the server stops the work. Before 2026-07-28 a server could also cancel its own requests.",
    howTo:
      "Stop work when you receive notifications/cancelled, or on 2026-07-28 HTTP when the request's stream closes. On 2026-07-28, send notifications/cancelled only to end a subscriptions/listen stream.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/patterns/cancellation"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    // Traffic shows a server cancelling its own request, which only legacy
    // revisions allow; nothing on the wire shows a server stopping work.
    assessment: {
      primary: "observed",
      observable: true,
      observableEra: "legacy",
    },
  },
  {
    id: "request-control.ping",
    family: "request-control",
    name: "ping",
    summary:
      "Either side checks that the connection is alive with a request that returns an empty result.",
    howTo:
      "Answer ping with an empty result. SDKs do this for you on 2025 revisions.",
    owner: "server",
    spec: coreSpec("2025-11-25", "basic/utilities/ping"),
    stage: "stable",
    lifecycle: lifecycle({ removed: "2026-07-28" }),
    optional: false,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "request-control.logging",
    family: "request-control",
    name: "logging capability",
    summary: "Declares that the server sends log messages to the client.",
    howTo:
      "Declare logging and send notifications/message. Logging is deprecated on 2026-07-28, so prefer your own telemetry.",
    owner: "server",
    spec: coreSpec("2026-07-28", LOGGING),
    stage: "stable",
    lifecycle: lifecycle({ deprecated: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: declaresCapability("logging"),
    },
  },
  {
    id: "request-control.logging-set-level",
    family: "request-control",
    parent: "request-control.logging",
    name: "logging/setLevel",
    summary: "The client picks the lowest log level it wants for the session.",
    howTo: "Handle logging/setLevel and drop messages below that level.",
    owner: "server",
    spec: coreSpec("2025-11-25", LOGGING, "setting-log-level"),
    stage: "stable",
    lifecycle: lifecycle({ removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "request-control.log-messages",
    family: "request-control",
    parent: "request-control.logging",
    name: "Log messages (notifications/message)",
    summary: "Structured log messages with a level, a logger name and data.",
    howTo:
      "Send notifications/message at or above the requested level. On 2026-07-28 send them only when the request asks for a log level.",
    owner: "server",
    spec: coreSpec("2026-07-28", LOGGING),
    stage: "stable",
    lifecycle: lifecycle({ deprecated: "2026-07-28" }),
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "request-control.per-request-log-level",
    family: "request-control",
    parent: "request-control.logging",
    name: "Per-request log level",
    summary:
      "Each 2026-07-28 request names the log level it wants in its _meta.",
    howTo:
      "Read io.modelcontextprotocol/logLevel from the request's _meta and send logs only at or above it.",
    owner: "server",
    spec: coreSpec("2026-07-28", LOGGING, "per-request-log-level"),
    stage: "stable",
    lifecycle: lifecycle({
      introduced: "2026-07-28",
      deprecated: "2026-07-28",
    }),
    optional: true,
    assessment: { primary: "checked" },
  },
  {
    id: "request-control.trace-context",
    family: "request-control",
    name: "Trace context",
    summary:
      "traceparent, tracestate and baggage in _meta tie a request to your distributed traces.",
    howTo:
      "Read traceparent and tracestate from the request's _meta and pass them to your tracing library.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "meta"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed" },
  },
];
