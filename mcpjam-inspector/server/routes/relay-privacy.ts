import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { scrubSensitiveUrl } from "../../shared/credential-url.js";
import {
  captureContextKey,
  CONSERVATIVE_TELEMETRY_POLICY,
  decodeCaptureContext,
  IDENTIFYING_PERSON_PROPERTIES,
  MASKED_ATTRIBUTE_VALUE,
  MASKED_REPLAY_BLOCKED_TAGS,
  MASKED_REPLAY_KEPT_ATTRIBUTES,
  maskReplayText,
  mostRestrictivePolicy,
  scrubNamesFromUrl,
  scrubStyleUrls,
  TELEMETRY_CONTEXT_PROPERTY,
  type TelemetryCaptureContext,
  type TelemetryPolicy,
} from "../../shared/telemetry-privacy.js";
import type { TelemetryPolicyResolution } from "../services/telemetry-privacy-policy.js";

/**
 * The relay's privacy gate: what an event may carry to PostHog, decided per
 * event from the context it was captured under.
 *
 * Every capture event carries a stamp (`TELEMETRY_CONTEXT_PROPERTY`, written
 * by the client's `before_send`) naming the projects and organizations in view
 * when it was captured, and the policy the client applied. The relay asks the
 * backend for the policy of those contexts as the request's bearer, takes the
 * stricter of that and the client's label, and removes the stamp. A label can
 * only tighten: it never authorizes full capture. An event with no stamp, a
 * request with no bearer, or a backend that does not answer gets the
 * conservative policy — masked replay, id-only identity.
 *
 * A restricted event is forwarded only after:
 *   - its person properties lose every field that names a human;
 *   - its URLs lose credential tokens and names, its autocapture elements
 *     lose their text and attributes, and its IP and GeoIP enrichment go;
 *   - its replay data passes `restrictSnapshotData`: an explicit allowlist of
 *     rrweb structures, rebuilt field by field with text and inputs masked,
 *     media blocked, console and network plugin data removed. Anything the
 *     allowlist does not know is refused (`UnsupportedReplayError`), never
 *     forwarded unchanged.
 */

export class UnsupportedReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedReplayError";
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

// ── Policy per event ───────────────────────────────────────────────────

/** Distinct capture contexts asked about per request; past it, conservative. */
export const MAX_CONTEXTS_PER_REQUEST = 8;

export type ResolvePolicy = (
  token: string | null,
  context: Pick<TelemetryCaptureContext, "projectIds" | "organizationIds">,
) => Promise<TelemetryPolicyResolution>;

/** Anything short of full recording with full identity. */
export function isRestricted(policy: TelemetryPolicy): boolean {
  return policy.recording !== "full" || policy.identity !== "full";
}

export interface PolicyDecision {
  /** One policy per event, in order. */
  policies: TelemetryPolicy[];
  /** Events whose policy could not be resolved: no stamp, bearer or answer. */
  unresolved: number;
}

/**
 * The effective policy of each event: the backend's answer for the context it
 * was captured under, tightened by the client's own label. Each distinct
 * context is asked once per request, in parallel, and never cached.
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
  return { policies, unresolved };
}

// ── Events ─────────────────────────────────────────────────────────────

const URL_PROPERTIES = [
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
];

function scrubUrl(value: string): string {
  return scrubNamesFromUrl(scrubSensitiveUrl(value));
}

/** A URL from a payload nobody vouched for: scrubbed, or a placeholder. */
function scrubPayloadUrl(value: unknown): string {
  if (typeof value !== "string") return "[name]";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith("/")) {
    return "[name]";
  }
  return scrubUrl(value);
}

function withoutIdentifying(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out = { ...value };
  for (const key of IDENTIFYING_PERSON_PROPERTIES) delete out[key];
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

const REQUEST_HEADER_CONFIG_KEYS = ["request_headers", "xhr_headers"];

/**
 * posthog-js records its config into replay as a `$posthog_config` custom
 * event, `request_headers` — the relay bearer — included. Removed from every
 * snapshot, whatever its policy. Returns the data unchanged when it is not
 * an event list.
 */
export function stripSnapshotCredentials(snapshotData: unknown): unknown {
  if (!Array.isArray(snapshotData)) return snapshotData;
  return snapshotData.map((entry) => {
    if (
      !isRecord(entry) ||
      entry.type !== 5 ||
      !isRecord(entry.data) ||
      entry.data.tag !== "$posthog_config" ||
      !isRecord(entry.data.payload) ||
      !isRecord(entry.data.payload.config)
    ) {
      return entry;
    }
    const config = { ...entry.data.payload.config };
    for (const key of REQUEST_HEADER_CONFIG_KEYS) delete config[key];
    return {
      ...entry,
      data: { ...entry.data, payload: { ...entry.data.payload, config } },
    };
  });
}

export interface RestrictionBudget {
  /** Bytes the replay's inner compressed fields may still inflate to. */
  inflatedBytesLeft: number;
  /**
   * Called when a field would inflate past `inflatedBytesLeft`: raises it to
   * the large-payload allowance, once, by taking a large admission slot.
   * Throws `RelayBusyError` when none is free; does nothing for a request
   * that already holds one.
   */
  widen?: () => void;
}

/** The relay has no room to inflate this replay now; the client retries. */
export class RelayBusyError extends Error {
  constructor() {
    super("relay busy");
    this.name = "RelayBusyError";
  }
}

// A gzip member is at least a 10-byte header and an 8-byte trailer.
const GZIP_MIN_BYTES = 18;

/**
 * The inflated size a gzip member declares in its trailer (ISIZE). Inflation
 * is held to exactly this size, so a member that declares less than it holds
 * (or more than one member) fails to inflate.
 */
export function gzipDeclaredBytes(bytes: Uint8Array): number | null {
  if (bytes.length < GZIP_MIN_BYTES) return null;
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).readUInt32LE(bytes.length - 4);
}

/**
 * A copy of `event` fit for its policy, stamp removed. Restricted events lose
 * names, IP, URL names, autocapture text, and get their replay masked.
 */
export async function applyEventPolicy(
  event: unknown,
  policy: TelemetryPolicy,
  budget: RestrictionBudget,
): Promise<unknown> {
  if (!isRecord(event)) return event;
  const properties: Json = isRecord(event.properties)
    ? { ...event.properties }
    : {};
  delete properties[TELEMETRY_CONTEXT_PROPERTY];
  const out: Json = { ...event, properties };

  if (event.event === "$snapshot" && "$snapshot_data" in properties) {
    properties.$snapshot_data = stripSnapshotCredentials(
      properties.$snapshot_data,
    );
  }

  if (policy.identity === "id_only") {
    if ("$set" in out) out.$set = withoutIdentifying(out.$set);
    if ("$set_once" in out) out.$set_once = withoutIdentifying(out.$set_once);
    if ("$set" in properties)
      properties.$set = withoutIdentifying(properties.$set);
    if ("$set_once" in properties) {
      properties.$set_once = withoutIdentifying(properties.$set_once);
    }
  }

  if (isRestricted(policy)) {
    // No client IP and nothing derived from one. The relay also withholds
    // the forwarding headers for any request that carries such an event.
    delete properties.$ip;
    properties.$geoip_disable = true;
  }

  if (policy.recording === "masked") {
    for (const key of URL_PROPERTIES) {
      if (typeof properties[key] === "string") {
        properties[key] = scrubUrl(properties[key] as string);
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
    if (event.event === "$snapshot" && "$snapshot_data" in properties) {
      properties.$snapshot_data = await restrictSnapshotData(
        properties.$snapshot_data,
        budget,
      );
    }
  }
  return out;
}

// ── Replay ─────────────────────────────────────────────────────────────

/** posthog-js's partial-compression format for rrweb events. */
const COMPRESSION_VERSION = "2024-10";
const MAX_NODE_DEPTH = 1024;
const MAX_CUSTOM_STRING = 128;

interface MaskContext {
  budget: RestrictionBudget;
  /** Ids of `<style>` elements seen in this request: their text is CSS. */
  styleIds: Set<number>;
}

async function decompressField(
  value: unknown,
  ctx: MaskContext,
): Promise<unknown> {
  if (typeof value !== "string") {
    throw new UnsupportedReplayError("compressed field is not a string");
  }
  const bytes = Buffer.from(value, "latin1");
  const declared = gzipDeclaredBytes(bytes);
  if (declared === null) {
    throw new UnsupportedReplayError("compressed field is not gzip");
  }
  // Checked before inflating, against what the request was admitted for: a
  // request admitted as small widens to the large allowance (taking a large
  // admission slot) or waits.
  if (declared > ctx.budget.inflatedBytesLeft) ctx.budget.widen?.();
  if (declared > ctx.budget.inflatedBytesLeft) {
    throw new UnsupportedReplayError("replay inflates past its budget");
  }
  let inflated: Buffer;
  try {
    inflated = await gunzipAsync(bytes, {
      maxOutputLength: Math.max(1, declared),
    });
  } catch {
    throw new UnsupportedReplayError("compressed field does not inflate");
  }
  ctx.budget.inflatedBytesLeft -= inflated.length;
  try {
    return JSON.parse(inflated.toString("utf8"));
  } catch {
    throw new UnsupportedReplayError("compressed field is not JSON");
  }
}

async function compressField(value: unknown): Promise<string> {
  return (await gzipAsync(Buffer.from(JSON.stringify(value)))).toString(
    "latin1",
  );
}

function compressionOf(event: Json): boolean {
  if (!("cv" in event) || event.cv === undefined) return false;
  if (event.cv !== COMPRESSION_VERSION) {
    throw new UnsupportedReplayError("unknown replay compression version");
  }
  return true;
}

function finiteNumberOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new UnsupportedReplayError(`${what}`);
  return value;
}

function maskAttributeValue(name: string, value: unknown): unknown {
  const key = name.toLowerCase();
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (key === "_csstext" && typeof value === "string") return value;
  if (
    (key === "rr_width" ||
      key === "rr_height" ||
      key === "rr_scrolltop" ||
      key === "rr_scrollleft") &&
    typeof value === "string"
  ) {
    return value;
  }
  // Mutations send style changes as an object of property → value pairs.
  if (key === "style" && isRecord(value)) {
    const style: Json = {};
    for (const [property, entry] of Object.entries(value)) {
      if (entry === false) {
        style[property] = entry;
      } else if (typeof entry === "string") {
        style[property] = scrubStyleUrls(entry);
      } else if (
        Array.isArray(entry) &&
        entry.every((part) => typeof part === "string")
      ) {
        style[property] = entry.map((part) => scrubStyleUrls(part));
      }
    }
    return style;
  }
  if (typeof value !== "string") {
    throw new UnsupportedReplayError("unknown attribute value");
  }
  if (key === "style") return scrubStyleUrls(value);
  if (MASKED_REPLAY_KEPT_ATTRIBUTES.has(key)) return value;
  return value === "" ? "" : MASKED_ATTRIBUTE_VALUE;
}

function maskAttributes(attributes: unknown): Json {
  if (attributes === undefined) return {};
  if (!isRecord(attributes)) {
    throw new UnsupportedReplayError("attributes are not an object");
  }
  const out: Json = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name.toLowerCase() === "rr_dataurl") continue;
    out[name] = maskAttributeValue(name, value);
  }
  return out;
}

function blockedAttributes(attributes: unknown): Json {
  const source = isRecord(attributes) ? attributes : {};
  const dimension = (rr: string, plain: string): string | undefined => {
    if (typeof source[rr] === "string" && /^[\d.]+px$/.test(source[rr])) {
      return source[rr] as string;
    }
    const n = Number(source[plain]);
    return Number.isFinite(n) && n >= 0 ? `${n}px` : undefined;
  };
  const out: Json = {};
  if (typeof source.class === "string") out.class = source.class;
  const width = dimension("rr_width", "width");
  const height = dimension("rr_height", "height");
  if (width) out.rr_width = width;
  if (height) out.rr_height = height;
  return out;
}

function copyNodeFlags(node: Json, out: Json): void {
  if (typeof node.id === "number") out.id = node.id;
  if (typeof node.rootId === "number") out.rootId = node.rootId;
  for (const flag of ["isShadowHost", "isShadow", "isSVG", "isCustom"]) {
    if (typeof node[flag] === "boolean") out[flag] = node[flag];
  }
}

/**
 * One serialized rrweb node, rebuilt with known fields only. `parentTag` is
 * the parent element's tag when it is known; only text directly inside a
 * known `<style>` keeps its content (it is CSS).
 */
function maskNode(
  node: unknown,
  ctx: MaskContext,
  parentTag: string | null,
  depth: number,
): Json {
  if (depth > MAX_NODE_DEPTH) {
    throw new UnsupportedReplayError("replay node nested too deep");
  }
  if (!isRecord(node) || typeof node.type !== "number") {
    throw new UnsupportedReplayError("replay node has no type");
  }
  const out: Json = { type: node.type };
  copyNodeFlags(node, out);
  const children = (tag: string | null) =>
    node.childNodes === undefined
      ? []
      : requireArray(node.childNodes, "childNodes is not a list").map((child) =>
          maskNode(child, ctx, tag, depth + 1),
        );
  switch (node.type) {
    case 0: // Document
      if (typeof node.compatMode === "string") out.compatMode = node.compatMode;
      out.childNodes = children(null);
      return out;
    case 1: // DocumentType
      for (const key of ["name", "publicId", "systemId"]) {
        if (typeof node[key] === "string") out[key] = node[key];
      }
      return out;
    case 2: {
      // Element
      if (typeof node.tagName !== "string") {
        throw new UnsupportedReplayError("element has no tag");
      }
      const tag = node.tagName.toLowerCase();
      out.tagName = node.tagName;
      if (tag === "style" && typeof node.id === "number") {
        ctx.styleIds.add(node.id);
      }
      if (MASKED_REPLAY_BLOCKED_TAGS.has(tag)) {
        out.attributes = blockedAttributes(node.attributes);
        out.childNodes = [];
        out.needBlock = true;
        return out;
      }
      out.attributes = maskAttributes(node.attributes);
      out.childNodes = children(tag);
      return out;
    }
    case 3: {
      // Text
      const text = typeof node.textContent === "string" ? node.textContent : "";
      const isCss = parentTag === "style";
      out.textContent = isCss ? text : maskReplayText(text);
      if (isCss && node.isStyle === true) out.isStyle = true;
      return out;
    }
    case 4: // CDATA
    case 5: // Comment
      out.textContent =
        typeof node.textContent === "string"
          ? maskReplayText(node.textContent)
          : "";
      return out;
    default:
      throw new UnsupportedReplayError("unknown replay node type");
  }
}

function maskFullSnapshot(data: unknown, ctx: MaskContext): Json {
  if (!isRecord(data)) {
    throw new UnsupportedReplayError("full snapshot has no data");
  }
  const out: Json = { node: maskNode(data.node, ctx, null, 0) };
  if (isRecord(data.initialOffset)) {
    out.initialOffset = {
      top: finiteNumberOr(data.initialOffset.top, 0),
      left: finiteNumberOr(data.initialOffset.left, 0),
    };
  }
  return out;
}

function maskMutationTexts(texts: unknown): unknown[] {
  return requireArray(texts, "mutation texts are not a list").map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "number") {
      throw new UnsupportedReplayError("mutation text has no id");
    }
    return {
      id: entry.id,
      value:
        typeof entry.value === "string" ? maskReplayText(entry.value) : null,
    };
  });
}

function maskMutationAttributes(attributes: unknown): unknown[] {
  return requireArray(attributes, "mutation attributes are not a list").map(
    (entry) => {
      if (!isRecord(entry) || typeof entry.id !== "number") {
        throw new UnsupportedReplayError("mutation attribute has no id");
      }
      return { id: entry.id, attributes: maskAttributes(entry.attributes) };
    },
  );
}

function maskMutationRemoves(removes: unknown): unknown[] {
  return requireArray(removes, "mutation removes are not a list").map(
    (entry) => {
      if (!isRecord(entry) || typeof entry.id !== "number") {
        throw new UnsupportedReplayError("mutation remove has no id");
      }
      const out: Json = { id: entry.id };
      if (typeof entry.parentId === "number") out.parentId = entry.parentId;
      if (typeof entry.isShadow === "boolean") out.isShadow = entry.isShadow;
      return out;
    },
  );
}

function maskMutationAdds(adds: unknown, ctx: MaskContext): unknown[] {
  return requireArray(adds, "mutation adds are not a list").map((entry) => {
    if (!isRecord(entry) || typeof entry.parentId !== "number") {
      throw new UnsupportedReplayError("mutation add has no parent");
    }
    const parentTag = ctx.styleIds.has(entry.parentId) ? "style" : null;
    const out: Json = {
      parentId: entry.parentId,
      nextId: typeof entry.nextId === "number" ? entry.nextId : null,
      node: maskNode(entry.node, ctx, parentTag, 0),
    };
    if (typeof entry.previousId === "number") out.previousId = entry.previousId;
    return out;
  });
}

const MUTATION_FIELDS = ["texts", "attributes", "removes", "adds"] as const;

async function maskMutation(
  data: Json,
  compressed: boolean,
  ctx: MaskContext,
): Promise<Json> {
  const out: Json = { source: 0 };
  if (typeof data.isAttachIframe === "boolean") {
    out.isAttachIframe = data.isAttachIframe;
  }
  for (const field of MUTATION_FIELDS) {
    const raw = data[field];
    const value = compressed ? await decompressField(raw, ctx) : (raw ?? []);
    const masked =
      field === "texts"
        ? maskMutationTexts(value)
        : field === "attributes"
          ? maskMutationAttributes(value)
          : field === "removes"
            ? maskMutationRemoves(value)
            : maskMutationAdds(value, ctx);
    out[field] = compressed ? await compressField(masked) : masked;
  }
  return out;
}

// IncrementalSource values (rrweb). Kept: geometry, interaction and CSS only.
const KEPT_INCREMENTAL_SOURCES = new Set([
  1, // MouseMove
  2, // MouseInteraction
  3, // Scroll
  4, // ViewportResize
  6, // TouchMove
  7, // MediaInteraction (play/pause timing; the media itself is blocked)
  8, // StyleSheetRule
  10, // Font
  12, // Drag
  13, // StyleDeclaration
  14, // Selection
  15, // AdoptedStyleSheet
  16, // CustomElement
]);
const DROPPED_INCREMENTAL_SOURCES = new Set([
  9, // CanvasMutation: media
  11, // Log: console
]);

async function restrictIncremental(
  event: Json,
  compressed: boolean,
  ctx: MaskContext,
): Promise<Json | null> {
  if (!isRecord(event.data) || typeof event.data.source !== "number") {
    throw new UnsupportedReplayError("incremental snapshot has no source");
  }
  const { data } = event;
  const source = data.source as number;
  if (source === 0) {
    return { ...event, data: await maskMutation(data, compressed, ctx) };
  }
  if (source === 5) {
    // Input
    if (typeof data.id !== "number") {
      throw new UnsupportedReplayError("input has no id");
    }
    const out: Json = {
      source,
      id: data.id,
      text: typeof data.text === "string" ? maskReplayText(data.text) : "",
      isChecked: data.isChecked === true,
    };
    if (typeof data.userTriggered === "boolean") {
      out.userTriggered = data.userTriggered;
    }
    return { ...event, data: out };
  }
  if (DROPPED_INCREMENTAL_SOURCES.has(source)) return null;
  if (KEPT_INCREMENTAL_SOURCES.has(source)) return event;
  throw new UnsupportedReplayError("unknown incremental snapshot source");
}

// Custom events posthog-js writes into a recording. Kept with primitive
// fields only (URLs scrubbed); anything else — `app-state` from the Redux
// logger included — is dropped from a restricted replay.
const KEPT_CUSTOM_TAGS = new Set([
  "$pageview",
  "$url_changed",
  "$posthog_config",
  "$remote_config_received",
  "$session_options",
  "$session_starting",
  "$session_ending",
  "$session_id_change",
  "$recording_started",
  "browser offline",
  "browser online",
  "recording paused",
  "recording resumed",
  "sessionIdle",
  "sessionNoLongerIdle",
  "triggerGroupSamplingDecisionMade",
  "window visible",
  "window hidden",
  "window prerender",
]);
const URL_PAYLOAD_KEYS = new Set(["href", "url"]);

function restrictCustom(event: Json): Json | null {
  if (!isRecord(event.data) || typeof event.data.tag !== "string") {
    throw new UnsupportedReplayError("custom event has no tag");
  }
  const { tag } = event.data;
  if (!KEPT_CUSTOM_TAGS.has(tag)) return null;
  const payload: Json = {};
  const source = isRecord(event.data.payload) ? event.data.payload : {};
  for (const [key, value] of Object.entries(source)) {
    if (URL_PAYLOAD_KEYS.has(key)) {
      payload[key] = scrubPayloadUrl(value);
    } else if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= MAX_CUSTOM_STRING)
    ) {
      payload[key] = value;
    }
  }
  return { ...event, data: { tag, payload } };
}

async function restrictRrwebEvent(
  event: unknown,
  ctx: MaskContext,
): Promise<Json | null> {
  if (!isRecord(event) || typeof event.type !== "number") {
    throw new UnsupportedReplayError("replay event has no type");
  }
  const compressed = compressionOf(event);
  switch (event.type) {
    case 0: // DomContentLoaded
    case 1: // Load
      return { ...event, data: {} };
    case 2: {
      // FullSnapshot
      const data = compressed
        ? await decompressField(event.data, ctx)
        : event.data;
      const masked = maskFullSnapshot(data, ctx);
      return {
        ...event,
        data: compressed ? await compressField(masked) : masked,
      };
    }
    case 3: // IncrementalSnapshot
      return await restrictIncremental(event, compressed, ctx);
    case 4: {
      // Meta
      const data = isRecord(event.data) ? event.data : {};
      return {
        ...event,
        data: {
          href: scrubPayloadUrl(data.href),
          width: finiteNumberOr(data.width, 0),
          height: finiteNumberOr(data.height, 0),
        },
      };
    }
    case 5: // Custom
      return restrictCustom(event);
    case 6: // Plugin: console and network recordings
      return null;
    default:
      throw new UnsupportedReplayError("unknown replay event type");
  }
}

/**
 * `$snapshot_data` for a restricted replay: each rrweb event rebuilt from the
 * allowlist, compressed fields decoded and re-encoded, unknown structures
 * refused. Yields between events so a large batch does not hold the loop.
 */
export async function restrictSnapshotData(
  snapshotData: unknown,
  budget: RestrictionBudget,
): Promise<unknown[]> {
  const events = requireArray(snapshotData, "snapshot data is not a list");
  const ctx: MaskContext = { budget, styleIds: new Set() };
  const out: unknown[] = [];
  for (let i = 0; i < events.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldToEventLoop();
    const masked = await restrictRrwebEvent(events[i], ctx);
    if (masked) out.push(masked);
  }
  return out;
}
