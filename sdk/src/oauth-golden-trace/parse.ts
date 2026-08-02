/**
 * HP-44 — wire parsing shared by every capture path.
 *
 * Both capture paths (an in-process emulator run and a HAR from a proxy) arrive
 * with bodies as loosely-typed blobs: sometimes a string, sometimes an already
 * parsed object, with a content-type that may or may not be accurate. This
 * module resolves them into the structured {@link TraceBody} the differ can
 * compare field by field.
 *
 * The bias throughout is to STRUCTURE where structure is real and `opaque`
 * otherwise. A body recorded as `opaque` is honest about being uncomparable; a
 * body force-parsed into the wrong encoding produces confident nonsense.
 */

import type { TraceBody } from "./types.js";

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** Multi-valued parse of an `application/x-www-form-urlencoded` payload. */
export function parseFormFields(raw: string): Record<string, string[]> {
  // Null-prototype: `__proto__` is a legal form field name, and `fields["__proto__"] ??= []`
  // on a plain object literal reparents the accumulator rather than recording a
  // field. Normalization hardens the same way, but that is too late — the field
  // has to survive parsing to reach it.
  const fields: Record<string, string[]> = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw).entries()) {
    (fields[key] ??= []).push(value);
  }
  return fields;
}

function isJsonRpcEnvelope(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).jsonrpc === "2.0"
  );
}

function isJsonRpc(value: unknown): boolean {
  // A batch is JSON-RPC only if EVERY entry is an envelope. A mixed array is
  // plain `json`: calling it `jsonrpc` would claim a protocol the bytes do not
  // honour, and an empty array is not a legal batch at all.
  if (Array.isArray(value)) {
    // `.every` SKIPS holes in a sparse array rather than invoking the predicate
    // on them, so `[envelope, <hole>, envelope].every(isJsonRpcEnvelope)` was
    // `true` — a slot that is not an envelope at all passing vacuously.
    // `Array.from` materializes every hole as `undefined`, which
    // `isJsonRpcEnvelope` correctly rejects, so every slot actually
    // participates.
    const materialized = Array.from(value);
    return materialized.length > 0 && materialized.every(isJsonRpcEnvelope);
  }
  return isJsonRpcEnvelope(value);
}

function jsonRpcMethodOf(value: unknown): string | undefined {
  // A batch has no single `method`, so nothing is hoisted — leaving `method`
  // absent is honest, and consumers already fall back to other leg signals.
  if (!isJsonRpcEnvelope(value)) return undefined;
  const method = (value as Record<string, unknown>).method;
  return typeof method === "string" ? method : undefined;
}

function asStructured(value: unknown): TraceBody {
  const method = jsonRpcMethodOf(value);
  if (isJsonRpc(value)) {
    return { encoding: "jsonrpc", ...(method ? { method } : {}), json: value };
  }
  return { encoding: "json", json: value };
}

/**
 * Resolve a raw body into a {@link TraceBody}.
 *
 * Content-type is used as a HINT, not as truth: proxies mislabel, and OAuth
 * endpoints in the wild are inconsistent about it. The shape of the payload wins
 * whenever the two disagree — a body that parses as JSON is JSON regardless of
 * what the header claimed.
 */
export function parseTraceBody(
  raw: unknown,
  headers?: Record<string, string>,
): TraceBody | undefined {
  if (raw == null) return undefined;

  const contentType = headerValue(headers, "content-type");

  if (typeof raw === "object") {
    // `URLSearchParams` has no enumerable own properties, so the object walk
    // below would read it as an EMPTY form body and silently drop the token
    // leg's grant/resource/PKCE fields. Its serialized form is the wire form, so
    // parse that — and do it regardless of content-type, since the type itself
    // is already proof the body was form-encoded.
    if (raw instanceof URLSearchParams) {
      return { encoding: "form", fields: parseFormFields(raw.toString()) };
    }

    // An already-parsed object whose content-type says form-urlencoded IS a form
    // body — the SDK's own token requests arrive this way. Encoding it as `json`
    // would make the same logical request diff unequal against a HAR capture of
    // the identical bytes, purely because of how each capture path happened to
    // hold it in memory.
    const isFormContentType = contentType
      ?.toLowerCase()
      .includes("application/x-www-form-urlencoded");
    if (isFormContentType && !Array.isArray(raw)) {
      // `Object.create(null)`, not `{}`: `raw`'s keys come from the wire, and a
      // client (or an attacker probing one) can send `__proto__` as a form field
      // name. Against a plain object literal that hits the inherited setter
      // instead of becoming an own property, and the field silently vanishes
      // from the trace — the oracle then reports absence for something the
      // client demonstrably sent.
      const fields: Record<string, string[]> = Object.create(null);
      let flat = true;
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value == null) continue;
        if (typeof value === "string") {
          fields[key] = [value];
        } else if (typeof value === "number" || typeof value === "boolean") {
          fields[key] = [String(value)];
        } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          fields[key] = [...(value as string[])];
        } else {
          // A nested object cannot have been form-encoded; the content-type is
          // wrong rather than the body, so fall back to structured.
          flat = false;
          break;
        }
      }
      if (flat) return { encoding: "form", fields };
    }

    // Already-parsed object. Empty objects are still meaningful (a `{}` DCR body
    // is a finding), so they are kept rather than dropped.
    return asStructured(raw);
  }

  if (typeof raw !== "string") {
    return { encoding: "json", json: raw };
  }

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  // Wire bytes, not UTF-16 code units: the HAR path fills this same field from
  // `content.size`, and the two capture paths must not describe one body with two
  // different numbers just because it contained non-ASCII text.
  const byteLength = new TextEncoder().encode(raw).length;

  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));

  if (looksJson) {
    try {
      return asStructured(JSON.parse(trimmed));
    } catch {
      // Fall through — a truncated JSON body is opaque, not form-encoded.
      return {
        encoding: "opaque",
        ...(contentType ? { contentType } : {}),
        byteLength,
      };
    }
  }

  const isFormContentType = contentType
    ?.toLowerCase()
    .includes("application/x-www-form-urlencoded");
  // A `k=v&k2=v2` payload with no content-type is still overwhelmingly a form
  // body on these endpoints; requiring the header would lose real token requests.
  const looksForm = /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(trimmed);

  if (isFormContentType || looksForm) {
    return { encoding: "form", fields: parseFormFields(trimmed) };
  }

  return {
    encoding: "opaque",
    ...(contentType ? { contentType } : {}),
    byteLength,
  };
}

/**
 * Recover loopback redirect ports before normalization strips them.
 *
 * Reads `redirect_uris` from a DCR body and `redirect_uri` from an authorize
 * query, since a client that registers no redirect URI may still send one.
 */
export function collectRedirectUris(input: {
  url: string;
  body?: TraceBody;
}): string[] {
  const uris: string[] = [];

  if (input.body?.encoding === "json") {
    const json = input.body.json;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const value = (json as Record<string, unknown>).redirect_uris;
      if (Array.isArray(value)) {
        for (const entry of value) if (typeof entry === "string") uris.push(entry);
      }
    }
  }

  if (input.body?.encoding === "form") {
    for (const value of input.body.fields.redirect_uri ?? []) uris.push(value);
    // A DCR body posted form-encoded carries the plural key, and `parseTraceBody`
    // will happily produce one. Reading only the singular key would drop the very
    // loopback ports this function exists to rescue from the `{port}` placeholder.
    for (const value of input.body.fields.redirect_uris ?? []) uris.push(value);
  }

  try {
    const parsed = new URL(input.url);
    for (const value of parsed.searchParams.getAll("redirect_uri")) uris.push(value);
  } catch {
    // Relative or malformed URL — nothing to recover.
  }

  return uris;
}
