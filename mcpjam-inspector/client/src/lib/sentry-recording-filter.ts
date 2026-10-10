import { scrubNamesFromUrl } from "../../../shared/telemetry-privacy";

/**
 * Sentry Replay's rrweb events cannot be edited as they are recorded —
 * `beforeAddRecordingEvent` sees only Sentry's own frames — and Sentry has
 * no relay. The rrweb event that carries the page URL is the Meta event
 * written at every checkout (`{ type: 4, data: { href } }`), so it is
 * scrubbed here instead, in Sentry's transport, on each `replay_recording`
 * item about to be sent: the recording is decompressed, its Meta hrefs lose
 * their names (`scrubNamesFromUrl`), and it is compressed again. A recording
 * that cannot be read is not sent. This runs at every level, as Sentry
 * Replay's own masking does.
 */

const META_EVENT = 4;

/** rrweb events with every Meta event's `href` scrubbed of names. */
export function scrubRecordingEvents(events: unknown): unknown {
  if (!Array.isArray(events)) return events;
  return events.map((event) => {
    const meta = event as { type?: unknown; data?: { href?: unknown } };
    if (meta?.type !== META_EVENT || typeof meta.data?.href !== "string") {
      return event;
    }
    return {
      ...meta,
      data: { ...meta.data, href: scrubNamesFromUrl(meta.data.href) },
    };
  });
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
      const events = JSON.parse(payload.slice(newline + 1));
      return `${payload.slice(0, newline + 1)}${JSON.stringify(
        scrubRecordingEvents(events),
      )}`;
    }
    if (!ArrayBuffer.isView(payload)) return null;
    const bytes = new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return null;
    const header = bytes.subarray(0, newline + 1);
    const events = JSON.parse(await inflate(bytes.subarray(newline + 1)));
    const body = await deflate(JSON.stringify(scrubRecordingEvents(events)));
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

async function filterEnvelope(envelope: Envelope): Promise<Envelope> {
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
        ...header,
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

interface TransportLike {
  send(envelope: never): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}

/** A Sentry transport whose replay recordings pass through the filter. */
export function withRecordingFilter<T extends TransportLike>(transport: T): T {
  return {
    ...transport,
    send: async (envelope: Envelope) =>
      await transport.send((await filterEnvelope(envelope)) as never),
    flush: (timeout?: number) => transport.flush(timeout),
  } as T;
}
