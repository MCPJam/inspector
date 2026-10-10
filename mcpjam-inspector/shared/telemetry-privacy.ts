/**
 * Telemetry privacy, shared by the client that captures and the relay that
 * forwards: the policy shape, the capture-context stamp each event carries,
 * the replay structures a restricted recording may keep, and the one URL name
 * scrubber both sides use.
 *
 * The policy comes from the backend (`telemetryPrivacy:getContext`), resolved
 * through the viewer's own project and organization access:
 *
 *   recording  `full` | `masked`   what session replay may record
 *   identity   `full` | `id_only`  whether name and email may ride along
 *
 * Anything that cannot be resolved — no answer yet, no access, no
 * authentication, a backend failure — is `CONSERVATIVE_TELEMETRY_POLICY`.
 * Policies combine by taking the stricter value of each field; nothing a
 * client says can make a policy laxer than the backend's.
 */

import { scrubSensitiveUrl } from "./credential-url";

export type TelemetryRecording = "full" | "masked";
export type TelemetryIdentity = "full" | "id_only";

export interface TelemetryPolicy {
  recording: TelemetryRecording;
  identity: TelemetryIdentity;
}

export const CONSERVATIVE_TELEMETRY_POLICY: Readonly<TelemetryPolicy> =
  Object.freeze({ recording: "masked", identity: "id_only" });

export const FULL_TELEMETRY_POLICY: Readonly<TelemetryPolicy> = Object.freeze({
  recording: "full",
  identity: "full",
});

export function isTelemetryPolicy(value: unknown): value is TelemetryPolicy {
  if (typeof value !== "object" || value === null) return false;
  const { recording, identity } = value as Record<string, unknown>;
  return (
    (recording === "full" || recording === "masked") &&
    (identity === "full" || identity === "id_only")
  );
}

/**
 * The stricter value of each field. A missing or malformed policy counts as
 * the conservative one, so an unknown never relaxes the result.
 */
export function mostRestrictivePolicy(
  ...policies: ReadonlyArray<TelemetryPolicy | null | undefined>
): TelemetryPolicy {
  let recording: TelemetryRecording = "full";
  let identity: TelemetryIdentity = "full";
  if (policies.length === 0) return { ...CONSERVATIVE_TELEMETRY_POLICY };
  for (const policy of policies) {
    if (!isTelemetryPolicy(policy)) return { ...CONSERVATIVE_TELEMETRY_POLICY };
    if (policy.recording === "masked") recording = "masked";
    if (policy.identity === "id_only") identity = "id_only";
  }
  return { recording, identity };
}

// ── Capture-context stamp ──────────────────────────────────────────────

/**
 * The event property the client stamps every PostHog event with at capture
 * time: the contexts in view when it was captured and the policy the client
 * applied to it. The relay validates the contexts against the backend and
 * removes the property before anything reaches PostHog.
 *
 * Captured, not sent: posthog-js queues and batches events, so a request can
 * leave after the person has navigated elsewhere. The stamp keeps each event
 * tied to where it was captured, so a later, laxer page never relaxes an
 * earlier event's handling.
 */
export const TELEMETRY_CONTEXT_PROPERTY = "$mcpjam_telemetry_context";

/** Matches the backend's `MAX_TELEMETRY_CONTEXT_IDS`. */
export const MAX_TELEMETRY_CONTEXT_IDS = 8;

const MAX_CONTEXT_ID_LENGTH = 64;

export interface TelemetryCaptureContext {
  projectIds: string[];
  organizationIds: string[];
  /**
   * What the client applied. It can only make the relay stricter: the relay
   * forwards with the stricter of this and the backend's answer.
   */
  policy: TelemetryPolicy;
}

/** The stamp as it travels: short keys, a version. */
export interface TelemetryContextStamp {
  v: 1;
  p: string[];
  o: string[];
  r: TelemetryRecording;
  i: TelemetryIdentity;
}

function cleanIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [
    ...new Set(
      ids.filter(
        (id): id is string =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= MAX_CONTEXT_ID_LENGTH,
      ),
    ),
  ]
    .sort()
    .slice(0, MAX_TELEMETRY_CONTEXT_IDS);
}

export function encodeCaptureContext(
  context: TelemetryCaptureContext,
): TelemetryContextStamp {
  return {
    v: 1,
    p: cleanIds(context.projectIds),
    o: cleanIds(context.organizationIds),
    r: context.policy.recording,
    i: context.policy.identity,
  };
}

/**
 * A stamp read back, or `null` when it is missing or malformed. A null
 * context is handled conservatively by the relay.
 */
export function decodeCaptureContext(
  value: unknown,
): TelemetryCaptureContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const stamp = value as Record<string, unknown>;
  if (stamp.v !== 1) return null;
  const policy = { recording: stamp.r, identity: stamp.i };
  if (!isTelemetryPolicy(policy)) return null;
  const ids = (raw: unknown): string[] | null => {
    if (!Array.isArray(raw) || raw.length > MAX_TELEMETRY_CONTEXT_IDS) {
      return null;
    }
    if (
      !raw.every(
        (id) =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= MAX_CONTEXT_ID_LENGTH,
      )
    ) {
      return null;
    }
    return cleanIds(raw as string[]);
  };
  const projectIds = ids(stamp.p);
  const organizationIds = ids(stamp.o);
  if (!projectIds || !organizationIds) return null;
  return { projectIds, organizationIds, policy };
}

/** A stable key for the ids of a context, for grouping a batch's events. */
export function captureContextKey(
  context: Pick<TelemetryCaptureContext, "projectIds" | "organizationIds">,
): string {
  return `${cleanIds(context.projectIds).join(",")}|${cleanIds(
    context.organizationIds,
  ).join(",")}`;
}

// ── Identity ───────────────────────────────────────────────────────────

/**
 * Person properties that name a human. Never sent while identity is
 * `id_only`; the relay removes them from restricted events, and the client
 * clears them from a PostHog person once identity becomes restrictive.
 */
export const IDENTIFYING_PERSON_PROPERTIES: readonly string[] = [
  "email",
  "name",
  "first_name",
  "last_name",
  "occupation",
  "username",
  "$email",
  "$name",
];

// ── Replay structures a restricted recording keeps ─────────────────────

/**
 * Attributes a `masked` replay keeps: the ones layout and styling need and
 * that never hold user text. Everything else — `title`, `alt`, `href`, `src`,
 * `placeholder`, `aria-label`, `id`, `value`, most `data-*` — is masked.
 * `class` and `style` stay so the replay is a styled layout rather than
 * unstyled boxes.
 */
export const MASKED_REPLAY_KEPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "style",
  "role",
  "type",
  "dir",
  "lang",
  "rel",
  "tabindex",
  "width",
  "height",
  "colspan",
  "rowspan",
  "disabled",
  "checked",
  "selected",
  "hidden",
  "open",
  "viewbox",
  "xmlns",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "transform",
  "opacity",
  "aria-hidden",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-disabled",
  "aria-pressed",
  "aria-current",
  "aria-orientation",
  "data-state",
  "data-side",
  "data-align",
  "data-orientation",
  "data-disabled",
  "data-highlighted",
  "data-selected",
  "data-active",
  "data-open",
  "data-slot",
  "data-variant",
  "data-size",
]);

export const MASKED_ATTRIBUTE_VALUE = "***";

export function maskReplayAttribute(name: string, value: string): string {
  return MASKED_REPLAY_KEPT_ATTRIBUTES.has(name.toLowerCase())
    ? value
    : MASKED_ATTRIBUTE_VALUE;
}

/** Text masked the way rrweb masks it: every visible character a `*`. */
export function maskReplayText(text: string): string {
  return text.replace(/\S/g, "*");
}

/**
 * Elements whose content a `masked` replay never copies: media and embedded
 * documents. `svg image` is matched as an `image` element inside an SVG.
 */
export const MASKED_REPLAY_BLOCKED_TAGS: ReadonlySet<string> = new Set([
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
  "image",
]);

// ── URL name scrubbing ─────────────────────────────────────────────────

const NAME_PLACEHOLDER = "[name]";
/** What `scrubSensitiveUrl` (shared/credential-url.ts) leaves behind. */
const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Path segments that are the app's own vocabulary: every literal segment of
 * the route table (`client/src/lib/app-routes.ts`) plus the prefixes replayed
 * network requests start with. Kept here, not derived from the route table,
 * because the relay scrubs with it too and cannot import client code;
 * `client/src/lib/__tests__/session-privacy.test.ts` fails when a route adds a
 * segment this list lacks.
 */
export const APP_ROUTE_WORDS: ReadonlySet<string> = new Set([
  "p",
  "api",
  "web",
  "v1",
  "mcp",
  "about",
  "api-keys",
  "appearance",
  "audit-log",
  "bench",
  "billing",
  "budget",
  "byok",
  "callback",
  "capabilities",
  "chat",
  "ci-evals",
  "client-config",
  "clients",
  "commit",
  "compare",
  "compatibility",
  "computer",
  "conformance",
  "create",
  "data-management",
  "discord",
  "edit",
  "embed",
  "environments",
  "eval-server",
  "evals",
  "evaluate",
  "github",
  "github-checks",
  "home",
  "host-compare",
  "hosts",
  "integrations",
  "learning",
  "login",
  "members",
  "models",
  "new",
  "oauth",
  "oauth-flow",
  "observability",
  "organizations",
  "plans",
  "playground",
  "plugins",
  "profile",
  "project-settings",
  "prompts",
  "registry",
  "resources",
  "results",
  "runs",
  "scenarios",
  "score",
  "secrets",
  "servers",
  "sessions",
  "settings",
  "shared",
  "sharing",
  "skills",
  "slack",
  "suite",
  "support",
  "swarms",
  "tasks",
  "test",
  "tools",
  "tracing",
  "usage",
  "user-testing",
  "webmcp",
  "xaa-flow",
]);

const HOST_PLACEHOLDER = "[host]";
/** Stands in for `[host]` while parsing, which a URL parser rejects. */
const HOST_SENTINEL = "host.scrub.invalid";

/**
 * Hosts a URL may keep: MCPJam's own, loopback, and the page's own origin
 * where there is one. Any other host — an MCP server's, a customer's CDN —
 * names something and becomes `[host]`.
 */
const APP_HOST_SUFFIXES = ["mcpjam.com", "caniuse.dev"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isAppHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (
    APP_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }
  const pageHost = (globalThis as { location?: { hostname?: unknown } })
    .location?.hostname;
  return typeof pageHost === "string" && pageHost.toLowerCase() === host;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids may stay: a document id says which record without saying what it is
 * called. Convex ids (lowercase base32, always with digits in practice),
 * UUIDs and plain numbers.
 */
export function isIdLike(value: string): boolean {
  return (
    /^\d+$/.test(value) ||
    UUID.test(value) ||
    (/^[0-9a-z]{25,40}$/.test(value) && /\d/.test(value))
  );
}

function scrubSegment(segment: string): string {
  if (
    !segment ||
    segment === NAME_PLACEHOLDER ||
    segment === REDACTED_PLACEHOLDER ||
    APP_ROUTE_WORDS.has(segment) ||
    isIdLike(segment)
  ) {
    return segment;
  }
  return NAME_PLACEHOLDER;
}

/**
 * Replace every name-like part of a URL — server names, project slugs, host
 * names, free-form query values — with a placeholder, keeping route words,
 * ids, and MCPJam's own hosts (`isAppHost`). The fragment and any userinfo
 * are dropped (they can hold anything, OAuth responses included). Credential
 * path segments go first, through the credential-URL sanitizer
 * (`scrubSensitiveUrl`), because a share token looks like an id. A value
 * that is not a URL or path is returned unchanged; one that fails to parse
 * becomes the placeholder. Idempotent.
 */
export function scrubNamesFromUrl(input: string): string {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  if (!isAbsolute && !input.startsWith("/")) return input;
  const value = scrubSensitiveUrl(input);
  try {
    const url = new URL(
      isAbsolute
        ? value.replace(
            /^([a-z][a-z0-9+.-]*:\/\/)\[host\]/i,
            `$1${HOST_SENTINEL}`,
          )
        : value,
      "http://scrub.invalid",
    );
    const path = url.pathname
      .split("/")
      .map((segment) => scrubSegment(decodeURIComponent(segment)))
      .join("/");
    const query = [...url.searchParams]
      .map(
        ([key, param]) =>
          `${encodeURIComponent(key)}=${
            isIdLike(param) ? encodeURIComponent(param) : NAME_PLACEHOLDER
          }`,
      )
      .join("&");
    const origin = !isAbsolute
      ? ""
      : `${url.protocol}//${
          url.hostname !== HOST_SENTINEL && isAppHost(url.hostname)
            ? url.host
            : HOST_PLACEHOLDER
        }`;
    return `${origin}${path}${query ? `?${query}` : ""}`;
  } catch {
    return NAME_PLACEHOLDER;
  }
}

/**
 * Any URL-shaped value, scrubbed: an absolute URL or path is
 * `scrubNamesFromUrl`ed; anything else becomes the placeholder. For fields
 * that are supposed to hold a URL but come from a payload nobody vouched for.
 */
export function scrubUntrustedUrl(value: unknown): string {
  if (typeof value !== "string") return NAME_PLACEHOLDER;
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!isAbsolute && !value.startsWith("/")) return NAME_PLACEHOLDER;
  return scrubNamesFromUrl(value);
}
