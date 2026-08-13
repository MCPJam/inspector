import { describeError, type NormalizedError } from "@mcpjam/sdk/browser";

/**
 * Turn an environment-resolution failure into a card the user can act on.
 *
 * ## Why this exists
 *
 * The backend raises a structured `ENV_*` code and a sentence, and the route
 * layer forwards BOTH — the sentence as `message`, the code in `details.code`
 * (see `server/services/environments/runtime.ts`). Until now the client threw
 * the code away and rendered the bare sentence as red text, which is why an
 * environment with no servers produced a wall of prose with nothing to click.
 *
 * The remedy is deliberately client-side. The backend sentence stays the
 * `oneLine` verbatim — it is the accurate statement of what went wrong — while
 * the likely causes and next steps are authored HERE, because they depend on
 * which surface is asking and the backend has no idea whether it is talking to
 * the Playground, a swarm launch, or an eval. No backend copy change needed.
 */

export interface EnvironmentErrorPayload {
  /** The backend's own sentence. Rendered verbatim as the card's one-liner. */
  message: string;
  /** `details.code` from the 409 — e.g. `ENV_NO_SERVERS`. */
  code?: string;
  details?: Record<string, unknown>;
}

const DOCS_ANCHOR = "/troubleshooting/error-codes";

/**
 * Pull the message AND the machine code out of a web-route error body.
 *
 * The body is `{ code, message, details?: { code? } }` (`webError`). The
 * environment routes put the TRANSPORT code (`conflict`) at the top level and
 * the DOMAIN code (`ENV_NO_SERVERS`) inside `details` — callers branch on the
 * domain one, so it wins.
 *
 * The message probe order — `error` (string or `{message}`), then a top-level
 * `message` — is deliberate: some route envelopes carry only the latter, and
 * dropping it would flatten an actionable resolve failure into the generic
 * fallback.
 *
 * Shared by the preview and tools hooks. Both hit routes that resolve through
 * the SAME backend query, so both see the same codes; two copies of this would
 * drift.
 */
export function readEnvironmentErrorPayload(
  payload: unknown,
  fallback: string
): EnvironmentErrorPayload {
  if (!payload || typeof payload !== "object") return { message: fallback };
  const record = payload as {
    error?: unknown;
    message?: unknown;
    code?: unknown;
    details?: unknown;
  };
  const details =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : undefined;
  const domainCode =
    details && typeof details.code === "string" ? details.code : undefined;
  const topCode = typeof record.code === "string" ? record.code : undefined;

  let message: string | undefined;
  if (typeof record.error === "string" && record.error.length > 0) {
    message = record.error;
  } else if (record.error && typeof record.error === "object") {
    const nested = (record.error as { message?: unknown }).message;
    if (typeof nested === "string" && nested.length > 0) message = nested;
  }
  if (!message && typeof record.message === "string" && record.message) {
    message = record.message;
  }

  const code = domainCode ?? topCode;
  return {
    message: message ?? fallback,
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
  };
}

export function isEnvironmentErrorPayload(
  value: unknown
): value is EnvironmentErrorPayload {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Per-code copy. Only codes whose remedy is genuinely different get an entry;
 * everything else falls through to the generic `ENV_*` shape below, which still
 * beats `describeError` because it keeps the backend's sentence and code.
 */
const ENV_COPY: Record<
  string,
  Pick<NormalizedError, "title" | "likelyCauses" | "nextSteps" | "severity">
> = {
  // Two genuinely different situations arrive under this one code, and the
  // second one is invisible from the sentence: an environment whose servers are
  // all LOCAL (stdio, or an http url on localhost / a private address) resolves
  // fine for a local run and is unusable for a cloud one, so a hosted surface
  // reads "no servers" while the client's Servers tab plainly shows one. Naming
  // the reachability reading here is the difference between "connect a server"
  // and "make the server you already have reachable" — different fixes, and the
  // user has no way to guess which applies.
  ENV_NO_SERVERS: {
    title: "This environment has no servers to run against",
    severity: "warning",
    likelyCauses: [
      "The client this environment points at has no servers connected",
      "The attached server group is empty",
      "Every server contributed by a pinned plugin has been removed",
      "The only servers are local — stdio, or a localhost/private-address url — and a cloud run can't reach them",
    ],
    nextSteps: [
      "Connect a server to the client, or attach a server group",
      "For a local server, expose it over HTTPS (Create tunnel on its card) and point the client at that url — or run this from a local surface instead",
      "Check the environment's pinned plugins if it relied on one for servers",
    ],
  },
  ENV_ARCHIVED: {
    title: "This environment is archived",
    severity: "warning",
    likelyCauses: ["Someone archived it after this was configured"],
    nextSteps: [
      "Restore it from the Environments list, or pick a different one",
    ],
  },
  ENV_HOST_MISSING: {
    title: "This environment's client no longer exists",
    severity: "error",
    likelyCauses: ["The client was deleted after the environment was created"],
    nextSteps: ["Point the environment at a different client, or recreate it"],
  },
  ENV_ATTACHMENT_MISSING: {
    title: "This environment's server group is gone",
    severity: "error",
    likelyCauses: ["The attached server group was deleted"],
    nextSteps: ["Attach a different server group, or clear the attachment"],
  },
};

/**
 * `NormalizedError` for an environment failure.
 *
 * Anything that is not a recognizable environment error — a network blip, an
 * auth failure, a thrown `Error` — delegates to `describeError`, which already
 * classifies those well and always returns a complete result.
 */
export function describeEnvironmentError(input: unknown): NormalizedError {
  if (!isEnvironmentErrorPayload(input)) return describeError(input);
  const { message, code } = input;
  if (!code || !code.startsWith("ENV_")) return describeError(message);

  const copy = ENV_COPY[code];
  return {
    slug: `environment/${code.toLowerCase()}`,
    title: copy?.title ?? "This environment can't run right now",
    // The backend's sentence, verbatim. It names the specific environment and
    // is the most accurate one-line statement available.
    oneLine: message,
    likelyCauses: copy?.likelyCauses ?? [],
    nextSteps: copy?.nextSteps ?? [
      "Open the environment and check its client, servers, and pins",
    ],
    docsAnchor: DOCS_ANCHOR,
    severity: copy?.severity ?? "error",
    rawMessage: message,
    rawCode: code,
  };
}

/**
 * True when the failure is specifically "resolves to zero servers".
 *
 * Surfaces use this to offer the one action that actually fixes it — opening
 * the client's servers — rather than a generic retry, which would just fail
 * again identically.
 */
export function isNoServersError(input: unknown): boolean {
  return isEnvironmentErrorPayload(input) && input.code === "ENV_NO_SERVERS";
}
