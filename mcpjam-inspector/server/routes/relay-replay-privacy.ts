import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  MASKED_ATTRIBUTE_VALUE,
  MASKED_REPLAY_BLOCKED_TAGS,
  MASKED_REPLAY_KEPT_ATTRIBUTES,
  maskReplayStyle,
  maskReplayText,
  scrubCssUrls,
  scrubUntrustedUrl,
} from "../../shared/telemetry-privacy.js";

/**
 * A restricted replay, for the relay's privacy gate (relay-privacy.ts):
 * posthog-js's `$snapshot_data` rebuilt from an explicit allowlist of rrweb
 * structures, field by field — text and inputs masked, URLs scrubbed from
 * styles and stylesheets, media and fonts blocked, console and network
 * plugin data removed. Compressed fields are inflated within the request's
 * budget, masked and re-compressed. Anything the allowlist does not know is
 * refused (`UnsupportedReplayError`), never forwarded unchanged.
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

// ── Replay ─────────────────────────────────────────────────────────────

/** posthog-js's partial-compression format for rrweb events. */
const COMPRESSION_VERSION = "2024-10";
const MAX_NODE_DEPTH = 1024;
const MAX_CUSTOM_STRING = 128;
// A compressed field is parsed whole once inflated, so one that would
// inflate past this is refused rather than parsed.
export const MAX_INFLATED_FIELD_BYTES = 8 * 1024 * 1024;
// The node walk yields to the event loop after this many nodes.
const NODES_PER_YIELD = 2_000;

interface MaskContext {
  budget: RestrictionBudget;
  /** Ids of `<style>` elements seen in this request: their text is CSS. */
  styleIds: Set<number>;
  /** Nodes walked since the last yield. */
  nodes: number;
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
  if (declared > MAX_INFLATED_FIELD_BYTES) {
    throw new UnsupportedReplayError("compressed field is too large");
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
  if (key === "_csstext" && typeof value === "string") {
    return scrubCssUrls(value);
  }
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
        style[property] = maskReplayStyle(entry);
      } else if (
        Array.isArray(entry) &&
        entry.every((part) => typeof part === "string")
      ) {
        style[property] = entry.map((part) => maskReplayStyle(part));
      }
    }
    return style;
  }
  if (typeof value !== "string") {
    throw new UnsupportedReplayError("unknown attribute value");
  }
  if (key === "style") return maskReplayStyle(value);
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
 * known `<style>` keeps its content (it is CSS, its URLs scrubbed). Yields
 * every NODES_PER_YIELD nodes, so a large DOM does not hold the loop.
 */
async function maskNode(
  node: unknown,
  ctx: MaskContext,
  parentTag: string | null,
  depth: number,
): Promise<Json> {
  if (depth > MAX_NODE_DEPTH) {
    throw new UnsupportedReplayError("replay node nested too deep");
  }
  if (!isRecord(node) || typeof node.type !== "number") {
    throw new UnsupportedReplayError("replay node has no type");
  }
  if (++ctx.nodes >= NODES_PER_YIELD) {
    ctx.nodes = 0;
    await yieldToEventLoop();
  }
  const out: Json = { type: node.type };
  copyNodeFlags(node, out);
  const children = async (tag: string | null): Promise<Json[]> => {
    if (node.childNodes === undefined) return [];
    const masked: Json[] = [];
    for (const child of requireArray(
      node.childNodes,
      "childNodes is not a list",
    )) {
      masked.push(await maskNode(child, ctx, tag, depth + 1));
    }
    return masked;
  };
  switch (node.type) {
    case 0: // Document
      if (typeof node.compatMode === "string") out.compatMode = node.compatMode;
      out.childNodes = await children(null);
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
      out.childNodes = await children(tag);
      return out;
    }
    case 3: {
      // Text
      const text = typeof node.textContent === "string" ? node.textContent : "";
      const isCss = parentTag === "style";
      out.textContent = isCss ? scrubCssUrls(text) : maskReplayText(text);
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

async function maskFullSnapshot(
  data: unknown,
  ctx: MaskContext,
): Promise<Json> {
  if (!isRecord(data)) {
    throw new UnsupportedReplayError("full snapshot has no data");
  }
  const out: Json = { node: await maskNode(data.node, ctx, null, 0) };
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

async function maskMutationAdds(
  adds: unknown,
  ctx: MaskContext,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const entry of requireArray(adds, "mutation adds are not a list")) {
    if (!isRecord(entry) || typeof entry.parentId !== "number") {
      throw new UnsupportedReplayError("mutation add has no parent");
    }
    const parentTag = ctx.styleIds.has(entry.parentId) ? "style" : null;
    const added: Json = {
      parentId: entry.parentId,
      nextId: typeof entry.nextId === "number" ? entry.nextId : null,
      node: await maskNode(entry.node, ctx, parentTag, 0),
    };
    if (typeof entry.previousId === "number") {
      added.previousId = entry.previousId;
    }
    out.push(added);
  }
  return out;
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
            : await maskMutationAdds(value, ctx);
    out[field] = compressed ? await compressField(masked) : masked;
  }
  return out;
}

// IncrementalSource values (rrweb). Kept as they are: geometry and
// interaction. CSS (8, 13, 15) is rebuilt below with its URLs scrubbed.
const KEPT_INCREMENTAL_SOURCES = new Set([
  1, // MouseMove
  2, // MouseInteraction
  3, // Scroll
  4, // ViewportResize
  6, // TouchMove
  7, // MediaInteraction (play/pause timing; the media itself is blocked)
  12, // Drag
  14, // Selection
  16, // CustomElement
]);
const DROPPED_INCREMENTAL_SOURCES = new Set([
  9, // CanvasMutation: media
  10, // Font: a font's family and source URL or bytes
  11, // Log: console
]);

function numberOrNumbers(value: unknown): number | number[] | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    Array.isArray(value) &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return value as number[];
  }
  return undefined;
}

function copySheetIds(data: Json, out: Json): void {
  if (typeof data.id === "number") out.id = data.id;
  if (typeof data.styleId === "number") out.styleId = data.styleId;
}

function cssRules(rules: unknown, what: string): Json[] {
  return requireArray(rules, what).map((rule) => {
    if (!isRecord(rule) || typeof rule.rule !== "string") {
      throw new UnsupportedReplayError(`${what}: rule is not text`);
    }
    const out: Json = { rule: scrubCssUrls(rule.rule) };
    const index = numberOrNumbers(rule.index);
    if (index !== undefined) out.index = index;
    return out;
  });
}

// StyleSheetRule (8): rules inserted, deleted or replaced, by CSSOM.
function restrictStyleSheetRule(data: Json): Json {
  const out: Json = { source: 8 };
  copySheetIds(data, out);
  if (data.adds !== undefined) {
    out.adds = cssRules(data.adds, "style sheet rule adds");
  }
  if (data.removes !== undefined) {
    out.removes = requireArray(data.removes, "style sheet rule removes").map(
      (entry) => {
        const index = isRecord(entry) ? numberOrNumbers(entry.index) : null;
        if (index === undefined || index === null) {
          throw new UnsupportedReplayError("style sheet rule remove");
        }
        return { index };
      },
    );
  }
  for (const key of ["replace", "replaceSync"]) {
    if (typeof data[key] === "string") {
      out[key] = scrubCssUrls(data[key] as string);
    }
  }
  return out;
}

// StyleDeclaration (13): one property set or removed on a rule — a value
// like an inline style's, masked the same way.
function restrictStyleDeclaration(data: Json): Json {
  const out: Json = { source: 13 };
  copySheetIds(data, out);
  const index = numberOrNumbers(data.index);
  if (index !== undefined) out.index = index;
  if (isRecord(data.set) && typeof data.set.property === "string") {
    out.set = {
      property: data.set.property,
      value:
        typeof data.set.value === "string"
          ? maskReplayStyle(data.set.value)
          : null,
      ...(typeof data.set.priority === "string"
        ? { priority: data.set.priority }
        : {}),
    };
  }
  if (isRecord(data.remove) && typeof data.remove.property === "string") {
    out.remove = { property: data.remove.property };
  }
  return out;
}

// AdoptedStyleSheet (15): constructed sheets attached to a document.
function restrictAdoptedStyleSheet(data: Json): Json {
  if (typeof data.id !== "number") {
    throw new UnsupportedReplayError("adopted style sheet has no id");
  }
  const styleIds = numberOrNumbers(data.styleIds);
  const out: Json = {
    source: 15,
    id: data.id,
    styleIds: Array.isArray(styleIds) ? styleIds : [],
  };
  if (data.styles !== undefined) {
    out.styles = requireArray(data.styles, "adopted styles").map((style) => {
      if (!isRecord(style) || typeof style.styleId !== "number") {
        throw new UnsupportedReplayError("adopted style has no id");
      }
      return {
        styleId: style.styleId,
        rules: cssRules(style.rules, "adopted style rules"),
      };
    });
  }
  return out;
}

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
  if (source === 8) return { ...event, data: restrictStyleSheetRule(data) };
  if (source === 13) return { ...event, data: restrictStyleDeclaration(data) };
  if (source === 15) return { ...event, data: restrictAdoptedStyleSheet(data) };
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
      payload[key] = scrubUntrustedUrl(value);
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
      const masked = await maskFullSnapshot(data, ctx);
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
          href: scrubUntrustedUrl(data.href),
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
  const ctx: MaskContext = { budget, styleIds: new Set(), nodes: 0 };
  const out: unknown[] = [];
  for (let i = 0; i < events.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldToEventLoop();
    const masked = await restrictRrwebEvent(events[i], ctx);
    if (masked) out.push(masked);
  }
  return out;
}
