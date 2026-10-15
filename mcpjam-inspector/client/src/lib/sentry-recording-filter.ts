import {
  maskReplayAttribute,
  maskReplayStyle,
  scrubNamesFromUrl,
} from "../../../shared/telemetry-privacy";
import { scrubRrwebCredentials } from "./rrweb-credential-scrub";
import { scrubClientSentryBreadcrumb, type ScrubbableBreadcrumb } from "../../../shared/sentry-config";

/**
 * Sentry Replay's rrweb events cannot be edited as they are recorded —
 * `beforeAddRecordingEvent` sees only Sentry's own frames — and Sentry has
 * no relay. So the DOM it records is cleaned here instead, in Sentry's
 * transport, on each `replay_recording` item about to be sent: the recording
 * is decompressed, cleaned, and compressed again. A recording that cannot be
 * read is not sent. This runs at every level, as Sentry Replay's own text
 * masking does.
 *
 * Cleaning means two things. The page URL in Meta events (written at every
 * checkout) loses its names (`scrubNamesFromUrl`). And element attributes, in
 * full snapshots and in later mutations, keep only what a masked PostHog
 * replay keeps (`maskReplayAttribute`): ids, `name`, `data-testid` and other
 * data attributes are built from customer data (`prompt-arg-${name}`,
 * `repo-row-${repoFullName}`), and Sentry's own `maskAttributes` is a fixed
 * list that cannot cover them.
 *
 * Then every credential comes out of the whole recording, the same pass
 * PostHog's replay batches get (`scrubRrwebCredentials`): stylesheet text
 * (`<style>` text, inlined stylesheets, CSSOM rule changes), which no Sentry
 * option masks, and every URL in meta, custom and plugin events.
 */

const FULL_SNAPSHOT_EVENT = 2;
const INCREMENTAL_EVENT = 3;
const META_EVENT = 4;
const MUTATION_SOURCE = 0;

// Local rather than `host-capabilities`' copy, which would pull the SDK into
// Sentry's init path.
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// rrweb's own bookkeeping on a serialized node, not page data: the size of a
// blocked element, scroll offsets, media state, and a stylesheet's text.
function isRrwebAttribute(name: string): boolean {
  return name.startsWith("rr_") || name === "_cssText";
}

function maskAttributeValue(name: string, value: unknown): unknown {
  if (isRrwebAttribute(name)) return value;
  if (typeof value === "string") return maskReplayAttribute(name, value);
  // A style mutation can arrive as a diff: `{ property: value | false }`.
  if (name.toLowerCase() === "style" && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([property, entry]) => [
        property,
        typeof entry === "string" ? maskReplayStyle(entry) : entry,
      ]),
    );
  }
  // `null` removes the attribute; anything else carries no text.
  return value;
}

function maskAttributes(attributes: unknown): void {
  if (!isRecord(attributes)) return;
  for (const [name, value] of Object.entries(attributes)) {
    attributes[name] = maskAttributeValue(name, value);
  }
}

/** Masks the attributes of `root` and every node under it, in place. */
function maskNodeTree(root: unknown): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    maskAttributes(node.attributes);
    if (Array.isArray(node.childNodes)) stack.push(...node.childNodes);
  }
}

function cleanEvent(event: unknown): void {
  if (!isRecord(event) || !isRecord(event.data)) return;
  const data = event.data;
  if (event.type === 5 && isRecord(data.payload)) {
    const origin = typeof window === "undefined" ? undefined : window.location.origin;
    if (data.tag === "breadcrumb") {
      data.payload = scrubClientSentryBreadcrumb(data.payload as ScrubbableBreadcrumb, origin) ?? {};
    } else if (data.tag === "performanceSpan" && typeof data.payload.description === "string") {
      const crumb = scrubClientSentryBreadcrumb({ category: "fetch", data: { url: data.payload.description } }, origin);
      data.payload.description = crumb?.data?.url;
    }
  }
  if (event.type === META_EVENT && typeof data.href === "string") {
    data.href = scrubNamesFromUrl(data.href);
  } else if (event.type === FULL_SNAPSHOT_EVENT) {
    maskNodeTree(data.node);
  } else if (
    event.type === INCREMENTAL_EVENT &&
    data.source === MUTATION_SOURCE
  ) {
    if (Array.isArray(data.adds)) {
      for (const add of data.adds) if (isRecord(add)) maskNodeTree(add.node);
    }
    if (Array.isArray(data.attributes)) {
      for (const change of data.attributes) {
        if (isRecord(change)) maskAttributes(change.attributes);
      }
    }
  }
}

/**
 * rrweb events, cleaned as described above. Edits `events` in place (it is
 * always a recording this module has just parsed), then returns the
 * credential-scrubbed copy, or `null` when the recording is not in a shape
 * the credential pass understands.
 */
export function scrubRecordingEvents(events: unknown): unknown[] | null {
  if (!Array.isArray(events)) return null;
  for (const event of events) cleanEvent(event);
  return scrubRrwebCredentials(events);
}

// Sentry compresses a recording as zlib, which is the format the Compression
// Streams API calls "deflate".
async function transform(
  input: BodyInit,
  stream: CompressionStream | DecompressionStream,
): Promise<Response> {
  const body = new Response(input).body;
  if (!body) throw new Error("no body");
  return new Response(body.pipeThrough(stream));
}

async function inflate(bytes: Uint8Array): Promise<string> {
  return await (
    await transform(bytes as BodyInit, new DecompressionStream("deflate"))
  ).text();
}

async function deflate(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await (
      await transform(text, new CompressionStream("deflate"))
    ).arrayBuffer(),
  );
}

function recordingHeader(text: string): string {
  const header: unknown = JSON.parse(text);
  if (!isRecord(header) || typeof header.segment_id !== "number" ||
    !Number.isSafeInteger(header.segment_id) || header.segment_id < 0) {
    throw new Error("Invalid replay segment");
  }
  return `${JSON.stringify({ segment_id: header.segment_id })}\n`;
}

/**
 * One `replay_recording` payload — a JSON header line, then the events,
 * compressed (bytes) or not (text) — with its events scrubbed. `null` when
 * it cannot be read.
 */
export async function filterReplayRecordingPayload(
  payload: unknown,
): Promise<string | Uint8Array | null> {
  try {
    if (typeof payload === "string") {
      const newline = payload.indexOf("\n");
      if (newline < 0) return null;
      const header = recordingHeader(payload.slice(0, newline));
      const events = scrubRecordingEvents(
        JSON.parse(payload.slice(newline + 1)),
      );
      if (events === null) return null;
      return `${header}${JSON.stringify(events)}`;
    }
    if (!ArrayBuffer.isView(payload)) return null;
    const bytes = new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return null;
    const header = new TextEncoder().encode(recordingHeader(new TextDecoder().decode(bytes.subarray(0, newline))));
    const events = scrubRecordingEvents(
      JSON.parse(await inflate(bytes.subarray(newline + 1))),
    );
    if (events === null) return null;
    const body = await deflate(JSON.stringify(events));
    const out = new Uint8Array(header.length + body.length);
    out.set(header);
    out.set(body, header.length);
    return out;
  } catch {
    return null;
  }
}

type EnvelopeItem = [Record<string, unknown>, unknown];
type Envelope = [unknown, EnvelopeItem[]];

export async function filterRecordingEnvelope(envelope: Envelope): Promise<Envelope> {
  const [headers, items] = envelope;
  if (!items.some(([header]) => header?.type === "replay_recording")) {
    return envelope;
  }
  const filtered: EnvelopeItem[] = [];
  for (const [header, payload] of items) {
    if (header?.type !== "replay_recording") {
      filtered.push([header, payload]);
      continue;
    }
    const recording = await filterReplayRecordingPayload(payload);
    if (recording === null) continue;
    filtered.push([
      {
        type: "replay_recording",
        length:
          typeof recording === "string"
            ? new TextEncoder().encode(recording).length
            : recording.length,
      },
      recording,
    ]);
  }
  return [headers, filtered];
}
