/**
 * What counts as a credential in a Meticulous recording, and how it is masked.
 * Shared by the network, storage and streaming hooks in
 * `meticulous-middleware.ts` and `meticulous-streams.ts`.
 */

/** Keys whose value is a credential wherever they appear, after `normalizeKey`. */
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "bearertoken",
  "apikey",
  "xapikey",
  "secret",
  "clientsecret",
  "password",
  "codeverifier",
  "privatekey",
]);
/** Keys whose every nested string is a credential: MCP server headers and env. */
const SECRET_CONTAINER_KEYS = new Set(["headers", "env", "secretpatch"]);
/** Form bodies and query strings only: an OAuth authorization code. In JSON, `code` is usually an error code. */
export const FORM_SECRET_KEYS = new Set(["code"]);

const normalizeKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

export function isSecretKey(key: string, extra?: Set<string>): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || (extra?.has(normalized) ?? false);
}

/** Same-length asterisks keep JSON shape and any length checks intact at replay. */
export function mask(value: string): string {
  return "*".repeat(value.length);
}

/**
 * Masks every string under a secret key, and every string inside a secret
 * container. Returns the input itself when nothing changed, so untouched
 * payloads are never copied.
 */
export function maskSecrets(value: unknown, insideSecret = false): unknown {
  if (typeof value === "string") return insideSecret ? mask(value) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const masked = maskSecrets(item, insideSecret);
      if (masked !== item) changed = true;
      return masked;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const secret =
        insideSecret ||
        isSecretKey(key) ||
        SECRET_CONTAINER_KEYS.has(normalizeKey(key));
      const masked = maskSecrets(child, secret);
      if (masked !== child) changed = true;
      out[key] = masked;
    }
    return changed ? out : value;
  }
  return value;
}

export function maskJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON, so there is no structure to walk; the text is returned as is.
    return text;
  }
  const masked = maskSecrets(parsed);
  return masked === parsed ? text : JSON.stringify(masked);
}

export function maskFormText(text: string): string {
  const params = new URLSearchParams(text);
  let changed = false;
  for (const key of Array.from(new Set(params.keys()))) {
    const value = params.get(key);
    if (value && isSecretKey(key, FORM_SECRET_KEYS)) {
      params.set(key, mask(value));
      changed = true;
    }
  }
  return changed ? params.toString() : text;
}

const JSON_FIELD = /("([A-Za-z0-9_.-]+)"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
/** The same field once JSON-escaped inside another string, as a tool result is. */
const ESCAPED_JSON_FIELD =
  /(\\"([A-Za-z0-9_.-]+)\\"\s*:\s*\\")((?:[^"\\]|\\[^"])*)(\\")/g;
/** `*` is in the token class so a token already half-masked by an earlier batch still matches whole. */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9\-._~+/*]+=*)/g;
/** A secret field whose value the text ends inside of: the rest arrives in a later batch. */
const OPEN_JSON_FIELD = /("([A-Za-z0-9_.-]+)"\s*:\s*")((?:[^"\\]|\\.)*\\?)$/;
const OPEN_ESCAPED_JSON_FIELD =
  /(\\"([A-Za-z0-9_.-]+)\\"\s*:\s*\\")((?:[^"\\]|\\[^"])*\\?)$/;
const OPEN_BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/*]+=*$/;

/** How a text ends inside a secret, which says what terminates it in the text that follows. */
export type OpenSecret = "json" | "escaped" | "bearer";

/** The rest of an open secret: everything up to its terminator, which stays. */
const OPEN_SECRET_REST: Record<OpenSecret, RegExp> = {
  json: /^((?:[^"\\]|\\.)*)"/,
  escaped: /^((?:[^"\\]|\\[^"])*)\\"/,
  bearer: /^([A-Za-z0-9\-._~+/*]+=*)/,
};

/** Whether `text` ends inside a secret value, after `maskText` has run on it. */
export function openSecretAtEnd(text: string): OpenSecret | null {
  const json = OPEN_JSON_FIELD.exec(text);
  if (json && isSecretKey(json[2])) return "json";
  const escaped = OPEN_ESCAPED_JSON_FIELD.exec(text);
  if (escaped && isSecretKey(escaped[2])) return "escaped";
  return OPEN_BEARER.test(text) ? "bearer" : null;
}

/**
 * Masks the start of `text` as the continuation of a secret left open by
 * the text before it, up to the terminator. `open` reports whether the
 * terminator was found; the caller decides what that proves. A bearer token
 * has no terminator of its own, so it closes with this text either way.
 */
export function maskOpenSecret(
  text: string,
  open: OpenSecret,
): { text: string; open: OpenSecret | null } {
  const rest = OPEN_SECRET_REST[open].exec(text);
  if (rest) {
    return { text: mask(rest[1]) + text.slice(rest[1].length), open: null };
  }
  return { text: mask(text), open: open === "bearer" ? null : open };
}

const maskField = (
  match: string,
  prefix: string,
  key: string,
  value: string,
  suffix: string,
) => (value && isSecretKey(key) ? `${prefix}${mask(value)}${suffix}` : match);
/** The open patterns have no closing group; `replace` would pass the offset there. */
const maskOpenField = (
  match: string,
  prefix: string,
  key: string,
  value: string,
) => maskField(match, prefix, key, value, "");

/**
 * Masks secret fields and bearer tokens by pattern, for text that is not one
 * JSON document: server-sent events, streamed chat chunks and tool results
 * embedded as strings. Escapes inside a masked value become asterisks too,
 * which keeps the surrounding JSON valid. A field the text ends inside of is
 * masked to the end, so a value cut by a batch boundary never leaves whole.
 */
export function maskText(text: string): string {
  return text
    .replace(JSON_FIELD, maskField)
    .replace(ESCAPED_JSON_FIELD, maskField)
    .replace(OPEN_JSON_FIELD, maskOpenField)
    .replace(OPEN_ESCAPED_JSON_FIELD, maskOpenField)
    .replace(
      BEARER,
      (_match, prefix: string, token: string) => `${prefix}${mask(token)}`,
    );
}

/** A JSON key the text ends inside of, with its quote style; the rest arrives in a later batch. */
export type OpenKey = { partial: string; escaped: boolean };
const OPEN_KEY = /(?:[{,[]|^)\s*(\\?)"([A-Za-z0-9_.-]*)$/;
const KEY_REST = /^([A-Za-z0-9_.-]*)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/;
const ESCAPED_KEY_REST =
  /^([A-Za-z0-9_.-]*)\\"\s*:\s*\\"((?:[^"\\]|\\[^"])*)(\\"|)/;

export function openKeyAtEnd(text: string): OpenKey | null {
  const match = OPEN_KEY.exec(text);
  return match ? { partial: match[2], escaped: match[1] === "\\" } : null;
}

/**
 * Masks the value of a field whose key began in an earlier batch, when the
 * two halves of the key name a secret. Other batches may have arrived in
 * between, so the halves are joined here rather than through the carried
 * tail. Reports an unterminated value as open.
 */
export function maskSplitKey(
  text: string,
  key: OpenKey,
): { text: string; open: OpenSecret | null } {
  const match = (key.escaped ? ESCAPED_KEY_REST : KEY_REST).exec(text);
  if (!match || !isSecretKey(key.partial + match[1])) {
    return { text, open: null };
  }
  const [whole, , value, closing] = match;
  const head = whole.slice(0, whole.length - value.length - closing.length);
  return {
    text: head + mask(value) + closing + text.slice(whole.length),
    open: closing ? null : key.escaped ? "escaped" : "json",
  };
}
