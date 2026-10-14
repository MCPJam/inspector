import { rebuildStrictPostHogEvent } from "../../shared/strict-posthog.js";
import { relayEventMetadata } from "./relay-event-metadata.js";
import {
  captureContextKey,
  CONSERVATIVE_TELEMETRY_POLICY,
  decodeCaptureContext,
  IDENTIFYING_PERSON_PROPERTIES,
  mostRestrictivePolicy,
  scrubHostname,
  scrubNamesFromUrl,
  scrubUntrustedUrl,
  scrubUrlsInText,
  stripPostHogConfigHeaders,
  TELEMETRY_CONTEXT_PROPERTY,
  type TelemetryCaptureContext,
  type TelemetryPolicy,
  type TelemetryRecording,
  withoutIdentifyingProperties,
} from "../../shared/telemetry-privacy.js";
import type { TelemetryPolicyResolution } from "../services/telemetry-privacy-policy.js";

/**
 * The relay intersects each event's capture policy with the current backend
 * answer and send-time browser policy. A missing or unsupported stamp, missing
 * bearer, unresolved context or missing live header is conservative.
 *
 * Strict events are reconstructed from the closed product-event schema;
 * automatic capture and replay are discarded. Replay can pass only with an
 * eligible full-content policy, and loses relay credentials before forwarding.
 * Masked legacy policies retain their stricter recording/identity dimensions.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Policy per event ───────────────────────────────────────────────────

/** Distinct capture contexts asked about per request; past it, conservative. */
export const MAX_CONTEXTS_PER_REQUEST = 8;

export type ResolvePolicy = (
  token: string | null,
  context: Pick<TelemetryCaptureContext, "projectIds" | "organizationIds">,
) => Promise<TelemetryPolicyResolution>;

/** Anything short of full recording with full identity. */
export function isRestricted(policy: TelemetryPolicy): boolean {
  return (
    policy.content === "strict" ||
    policy.recording !== "full" ||
    policy.identity !== "full"
  );
}

export interface PolicyDecision {
  /** One policy per event, in order. */
  policies: TelemetryPolicy[];
  actorIds: Array<string | undefined>;
  /**
   * What each event's own stamp says the client recorded under, in order;
   * `null` when the event has no readable stamp.
   */
  declared: Array<TelemetryRecording | null>;
  /** Events whose policy could not be resolved: no stamp, bearer or answer. */
  unresolved: number;
}

/**
 * The effective policy of each event: the backend's answer for the context it
 * was captured under, tightened by the client's own label. Each distinct
 * context is asked once per request, in parallel. Only restrictive backend
 * answers may be reused between requests.
 */
export async function decideEventPolicies(
  events: readonly unknown[],
  token: string | null,
  resolve: ResolvePolicy,
): Promise<PolicyDecision> {
  const contexts = events.map((event) =>
    isRecord(event) && isRecord(event.properties)
      ? decodeCaptureContext(event.properties[TELEMETRY_CONTEXT_PROPERTY])
      : null,
  );
  const distinct = new Map<string, TelemetryCaptureContext>();
  for (const context of contexts) {
    if (context) distinct.set(captureContextKey(context), context);
  }
  const answers = new Map<string, TelemetryPolicyResolution>();
  if (token && distinct.size > 0 && distinct.size <= MAX_CONTEXTS_PER_REQUEST) {
    await Promise.all(
      [...distinct].map(async ([key, context]) => {
        answers.set(
          key,
          await resolve(token, {
            projectIds: context.projectIds,
            organizationIds: context.organizationIds,
          }),
        );
      }),
    );
  }
  let unresolved = 0;
  const declared = contexts.map((context) =>
    context ? context.policy.recording : null,
  );
  const policies = contexts.map((context) => {
    const answer = context
      ? answers.get(captureContextKey(context))
      : undefined;
    if (!context || !answer?.resolved) {
      unresolved++;
      return { ...CONSERVATIVE_TELEMETRY_POLICY };
    }
    return mostRestrictivePolicy(answer.policy, context.policy);
  });
  const actorIds = contexts.map((context) =>
    context
      ? answers.get(captureContextKey(context))?.telemetryActorId
      : undefined,
  );
  return { policies, actorIds, declared, unresolved };
}

// ── Events ─────────────────────────────────────────────────────────────

// Properties that hold a page URL or path.
const URL_PROPERTIES = new Set([
  "$current_url",
  "$referrer",
  "$pathname",
  "$session_entry_url",
  "$session_entry_pathname",
  "$session_entry_referrer",
  "$initial_current_url",
  "$initial_pathname",
  "$initial_referrer",
  "$prev_pageview_pathname",
  "$prev_pageview_url",
]);
// A property named for a name or an email (`project_name`, `serverName`).
const NAME_PROPERTY = /(?:^|_)(?:name|email)$|[a-z](?:Name|Email)$/;
// A property holding a host (`$referring_domain`, `$initial_referring_domain`).
const DOMAIN_PROPERTY = /(?:^|_)domain$/;
// Handled on their own: the stamp, replay data (masked by the client, passed
// or dropped whole) and autocapture elements.
const SEPARATELY_RESTRICTED = new Set([
  TELEMETRY_CONTEXT_PROPERTY,
  "$snapshot_data",
  "$elements",
  "$elements_chain",
  "$el_text",
]);
// Stack frame fields that locate code (the app's own bundle) and that error
// tracking needs to resolve a trace.
const CODE_LOCATION_KEYS = new Set(["filename", "abs_path"]);
const PERSON_PROPERTY_SETS = new Set(["$set", "$set_once"]);
const MAX_PROPERTY_DEPTH = 16;

/**
 * One property value of a restricted event, generically: a name-named
 * property is masked, a URL or path is scrubbed, a host is kept only when it
 * is ours, and any absolute URL inside other text is scrubbed — whatever the
 * property is called, since heatmaps, web vitals and autocapture switch on
 * from PostHog's remote config. `$heatmap_data` is keyed by URL, so its keys
 * are scrubbed too. Person properties that name a human are left to the
 * identity policy, which has already removed them when it is id-only.
 */
function restrictPropertyValue(
  key: string,
  value: unknown,
  depth: number,
  inPersonProperties: boolean,
): unknown {
  if (depth > MAX_PROPERTY_DEPTH) return "[redacted]";
  if (typeof value === "string") {
    if (URL_PROPERTIES.has(key)) return scrubNamesFromUrl(value);
    if (inPersonProperties && IDENTIFYING_PERSON_PROPERTIES.includes(key)) {
      return value;
    }
    if (NAME_PROPERTY.test(key)) return "[name]";
    if (DOMAIN_PROPERTY.test(key) || key === "$host") {
      return scrubHostname(value);
    }
    if (CODE_LOCATION_KEYS.has(key)) return value;
    return scrubUrlsInText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      restrictPropertyValue(key, item, depth + 1, inPersonProperties),
    );
  }
  if (isRecord(value)) {
    if (key === "$heatmap_data") return restrictHeatmapData(value, depth);
    return restrictProperties(
      value,
      depth + 1,
      inPersonProperties || PERSON_PROPERTY_SETS.has(key),
    );
  }
  return value;
}

function restrictProperties(
  properties: Json,
  depth: number,
  inPersonProperties: boolean,
): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] =
      depth === 0 && SEPARATELY_RESTRICTED.has(key)
        ? value
        : restrictPropertyValue(key, value, depth, inPersonProperties);
  }
  return out;
}

// `$heatmap_data`: `{ [href]: Array<point> }`. Pages that scrub to the same
// URL are merged.
function restrictHeatmapData(data: Json, depth: number): Json {
  const out: Json = {};
  for (const [href, points] of Object.entries(data)) {
    const key = scrubUntrustedUrl(href);
    const masked = restrictPropertyValue("points", points, depth + 1, false);
    const existing = out[key];
    out[key] =
      Array.isArray(existing) && Array.isArray(masked)
        ? [...existing, ...masked]
        : masked;
  }
  return out;
}

// Element-chain keys that carry no user text: position only, plus the class.
const KEPT_CHAIN_KEYS = new Set(["nth-child", "nth-of-type", "attr__class"]);

/**
 * `$elements_chain` (`tag.class:attr__x="…"text="…"`, values quoted with
 * backslash escapes): every key="value" pair goes except position and class.
 */
export function scrubElementsChain(chain: string): string {
  return chain.replace(
    /([A-Za-z_$][\w$-]*)="(?:[^"\\]|\\.)*"/g,
    (pair, key: string) => (KEPT_CHAIN_KEYS.has(key) ? pair : ""),
  );
}

function scrubElement(element: unknown): unknown {
  if (!isRecord(element)) return element;
  const out: Json = {};
  for (const [key, value] of Object.entries(element)) {
    if (key === "$el_text" || key === "text" || key === "attr_id") continue;
    if (key.startsWith("attr__") && key !== "attr__class") continue;
    if (key === "href") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Whether a replay event may be forwarded under `policy`, given what its own
 * stamp declared. See the module comment.
 */
export function replayAllowed(
  policy: TelemetryPolicy,
  declared: TelemetryRecording | null,
): boolean {
  if (policy.content === "strict") return false;
  if (policy.recording === "full") return true;
  return policy.recording === "masked" && declared === "masked";
}

/**
 * A copy of `event` fit for its policy, stamp removed, or `null` when it must
 * not be forwarded at all (a replay its policy does not allow). Restricted
 * events lose names, IP, URL names and autocapture text.
 */
export function applyEventPolicy(
  event: unknown,
  policy: TelemetryPolicy,
  declared: TelemetryRecording | null,
  actorId?: string,
): unknown {
  if (policy.content === "strict") {
    const rebuilt = rebuildStrictPostHogEvent(event, actorId);
    return rebuilt && isRecord(event)
      ? { ...rebuilt, ...relayEventMetadata(event) }
      : null;
  }
  if (!isRecord(event)) return null;
  if (event.event === "$snapshot" && !replayAllowed(policy, declared)) {
    return null;
  }
  const properties: Json = isRecord(event.properties)
    ? { ...event.properties }
    : {};
  delete properties[TELEMETRY_CONTEXT_PROPERTY];
  const out: Json = { ...event, properties };

  if (event.event === "$snapshot" && "$snapshot_data" in properties) {
    properties.$snapshot_data = stripPostHogConfigHeaders(
      properties.$snapshot_data,
    );
  }

  if (policy.identity === "id_only") {
    for (const target of [out, properties]) {
      for (const key of PERSON_PROPERTY_SETS) {
        if (key in target) {
          target[key] = withoutIdentifyingProperties(target[key]);
        }
      }
    }
  }

  if (isRestricted(policy)) {
    // No client IP and nothing derived from one. The relay also withholds
    // the forwarding headers for any request that carries such an event.
    delete properties.$ip;
    properties.$geoip_disable = true;
  }

  if (policy.recording === "masked") {
    Object.assign(properties, restrictProperties(properties, 0, false));
    // posthog-js puts `$initial_*` person properties in the event's own
    // `$set_once`, outside `properties`.
    for (const key of PERSON_PROPERTY_SETS) {
      if (isRecord(out[key])) {
        out[key] = restrictProperties(out[key] as Json, 1, true);
      }
    }
    delete properties.$el_text;
    if (Array.isArray(properties.$elements)) {
      properties.$elements = properties.$elements.map(scrubElement);
    }
    if (typeof properties.$elements_chain === "string") {
      properties.$elements_chain = scrubElementsChain(
        properties.$elements_chain,
      );
    }
  }
  return out;
}

/** A live request can only tighten its original capture/backend decisions. */
export function restrictPoliciesAtSend(
  decision: PolicyDecision,
  live: string | undefined,
): PolicyDecision {
  return live === "full"
    ? decision
    : {
        ...decision,
        policies: decision.policies.map((policy) =>
          mostRestrictivePolicy(policy, CONSERVATIVE_TELEMETRY_POLICY),
        ),
      };
}

/** A mixed batch cannot use the relay's address as a full row's client location. */
export function disableEventGeoip(event: Record<string, unknown>): void {
  const properties = isRecord(event.properties) ? { ...event.properties } : {};
  delete properties.$ip;
  properties.$geoip_disable = true;
  event.properties = properties;
}
