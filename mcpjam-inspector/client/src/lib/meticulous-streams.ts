import { maskText } from "./meticulous-secrets";

/**
 * Redaction for responses the Meticulous recorder captures as a stream:
 * chat replies and server-sent events. Each hook call carries one batch of
 * base64 chunks for one stream, with no stream id, so a field cut by a batch
 * boundary would otherwise reach neither call whole. The redactor keeps the
 * masked tail of the previous batch per URL and method and reads the next
 * batch in that context, so the cut field is seen and masked in both halves.
 */

type StreamingChunk = { offsetMs: number; data: string };
export type StreamBatch = {
  url: string;
  method: string;
  chunks: StreamingChunk[];
  completed: boolean;
};

/** Characters of the previous batch kept as context: longer than any one field. */
const CARRY_CHARS = 512;
/** Streams that never report `completed` must not grow the table forever. */
const MAX_OPEN_STREAMS = 32;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Bytes at the end that begin a multi-byte character the batch does not finish. */
function incompleteUtf8Tail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type Carry = { text: string; bytes: Uint8Array };

/**
 * Masks one batch in the context of what the same stream carried before.
 * Returns the batch unchanged when nothing in it is secret.
 */
export function redactStreamBatch<T extends StreamBatch>(
  entry: T,
  carry: Carry = { text: "", bytes: new Uint8Array(0) },
): { entry: T; carry: Carry } {
  const parts = entry.chunks.map((chunk) => decodeBase64(chunk.data));
  const bytes = concat([carry.bytes, ...parts]);
  if (bytes.length === 0) return { entry, carry };
  const keep = incompleteUtf8Tail(bytes);
  const text = new TextDecoder().decode(bytes.subarray(0, bytes.length - keep));
  const combined = carry.text + text;
  const masked = maskText(combined);
  const nextCarry = {
    text: masked.slice(-CARRY_CHARS),
    bytes: bytes.subarray(bytes.length - keep),
  };
  if (masked === combined) return { entry, carry: nextCarry };
  const encoded = new TextEncoder().encode(masked.slice(carry.text.length));
  // The carried bytes were already emitted with the previous batch.
  const rebuilt = concat([
    encoded.subarray(carry.bytes.length),
    nextCarry.bytes,
  ]);
  // Masking keeps ASCII length, so the boundaries line up unless a masked
  // value held non-ASCII text; then the last chunk absorbs the difference.
  let start = 0;
  const chunks = entry.chunks.map((chunk, index) => {
    const last = index === entry.chunks.length - 1;
    const end = last
      ? rebuilt.length
      : Math.min(rebuilt.length, start + parts[index].length);
    const data = encodeBase64(rebuilt.subarray(start, end));
    start = end;
    return { ...chunk, data };
  });
  return { entry: { ...entry, chunks }, carry: nextCarry };
}

/** One redactor per hook, so fetch and XHR streams keep separate tables. */
export function createStreamRedactor() {
  const open = new Map<string, Carry>();
  return <T extends StreamBatch>(entry: T): T => {
    const key = `${entry.method} ${entry.url}`;
    const { entry: redacted, carry } = redactStreamBatch(entry, open.get(key));
    open.delete(key);
    if (!entry.completed) {
      open.set(key, carry);
      if (open.size > MAX_OPEN_STREAMS) {
        const oldest = open.keys().next().value;
        if (oldest !== undefined) open.delete(oldest);
      }
    }
    return redacted;
  };
}
