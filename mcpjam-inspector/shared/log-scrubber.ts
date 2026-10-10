/**
 * What the server is willing to put in a log row or an error report.
 *
 * ONE module for every telemetry sink: the Axiom rows `server/utils/logger.ts`
 * writes (free-form and typed), the context it attaches to Sentry events, and
 * the request/breadcrumb/exception data the Sentry SDKs attach on their own
 * (`shared/sentry-config.ts`). Two scrubbers would drift, and the one that
 * drifted would be the leak.
 *
 * Three layers, applied by key name and by value shape:
 *
 *  1. Credentials. A secret-shaped KEY (`authorization`, `*token*`, `email`,
 *     …) is replaced outright; a secret-shaped VALUE (`Bearer …`, a JWT, an
 *     `sk-` key, `api_key=…`, an email address) is replaced inside any string.
 *  2. Customer content. A key that names a prompt, a chat message, a tool's
 *     arguments or result, a request body, a test case — see `CONTENT_WORDS`
 *     — keeps its STRUCTURE (keys, types, string lengths, array lengths) and
 *     loses its values. "The arguments were `{city: string(6)}`" is the part
 *     anyone debugging needs; the city is not.
 *  3. Free text. Every string first loses every credential the credential
 *     registry knows (`shared/credential-urls.ts`): a share token in a
 *     RELATIVE path (`/results/<token>`, which no URL pattern below sees),
 *     an OAuth `?code=`, a presigned signature. Then its absolute URLs are
 *     cut to their origin (a customer's MCP server URL carries tenant paths
 *     and query strings; the host is what tells you which server failed) and
 *     it is length-capped. Error text is capped harder: the first few
 *     hundred characters are the part anyone reads, and an upstream error can
 *     quote an entire response body.
 *
 * Ids, codes, statuses, counts, durations, model ids and tool names pass
 * through untouched — they are what makes a row worth writing.
 *
 * Pure — no SDK, no Node APIs — so the browser client (console breadcrumbs)
 * and the Electron main process share it with the server. It moved here from
 * `server/utils/` for that reason.
 */
import { scrubCredentialsInText } from "./credential-urls";
import {
  authHeaderLike,
  jwtLike,
  secretParamLike,
  skKeyLike,
  tokenLike,
  urlBasicAuthLike,
} from "./secret-shape-redaction";

const FORBIDDEN_KEY_SUBSTRINGS = [
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
  "apikey",
  "pkceverifier",
  "pkcechallenge",
  "stripecustomer",
  "stripesubscription",
  "stripeprice",
  "x-mcp-session-auth",
  "x-api-key",
  // Header-broker model lease (E2B network-transform delivery). A signed model
  // lease — never log it, even though the inspector never handles it directly
  // (defense in depth).
  "x-mcpjam-harness-lease",
];

const ALLOWLISTED_KEYS = new Set(["emaildomain"]);

/**
 * The LAST word of a key (`toolArgs` → `args`, `request_body` → `body`) that
 * marks its value as customer content: summarized to a shape, never shipped.
 *
 * Deliberately absent: `message` (the log line and every error's text — capped
 * and redacted as error text instead), `query` (Convex function names), `name`
 * (tool and error names are the debugging signal) and `data` (too generic).
 */
const CONTENT_WORDS = new Set([
  "prompt",
  "prompts",
  "instructions",
  "messages",
  "content",
  "contents",
  "parts",
  "input",
  "inputs",
  "output",
  "outputs",
  "args",
  "arguments",
  "params",
  "parameters",
  "result",
  "results",
  "body",
  "payload",
  "headers",
  "text",
  "transcript",
  "completion",
  "snapshot",
  "html",
  "markdown",
  "attachments",
  "title",
]);

/**
 * Labels a customer typed — a person's or a server's name. Matched on the whole
 * normalized key because `name` alone is far more often a tool or error name.
 */
const CONTENT_KEYS = new Set([
  "servername",
  "serverdisplayname",
  "displayname",
  "visitordisplayname",
  "firstname",
  "lastname",
  "fullname",
  "username",
]);

/** Words that mark a key's value as error text: capped and redacted. */
const ERROR_WORDS = new Set([
  "error",
  "errors",
  "err",
  "errmsg",
  "msg",
  "message",
  "detail",
  "details",
  "cause",
  "stderr",
  "stdout",
  "preview",
]);

const MAX_TEXT_CHARS = 1000;
/**
 * Matches the existing 500-character cap on `http.request.failed`'s
 * `errorMessage` (`request-log-context.ts`): long enough to keep the cause.
 */
export const MAX_ERROR_TEXT_CHARS = 500;
const MAX_STACK_CHARS = 4000;
const MAX_ARRAY_ITEMS = 50;

const SHAPE_MAX_DEPTH = 3;
const SHAPE_MAX_KEYS = 12;
const SHAPE_MAX_CHARS = 500;
const SHAPE_MAX_KEY_CHARS = 40;

// Credential patterns live in `shared/secret-shape-redaction.ts`, shared with
// the model path. They are factories: each regex has `g`, and a shared
// instance's `lastIndex` would skip matches between calls.
//
// `EMAIL_LIKE` stays here: logs redact addresses, but a model reading a page
// needs them.
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * An absolute web URL inside free text. Stops at whitespace, quotes and the
 * brackets prose and JSON wrap a URL in. Other schemes (`ui://`, `file://`,
 * `data:`) are left alone: an MCP App's `ui://` template name is a dashboard
 * dimension, not customer data.
 */
const URL_LIKE = () => /\b(?:https?|wss?):\/\/[^\s"'`<>(){}]+/gi;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALLOWLISTED_KEYS.has(lower)) return false;
  if (lower === "email" || lower.endsWith("email")) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

/** `toolArgs` → `["tool", "args"]`, `request_body` → `["request", "body"]`. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type KeyKind = "content" | "error" | "stack" | "plain";

function classifyKey(key: string): KeyKind {
  const words = keyWords(key);
  const last = words.at(-1) ?? "";
  // `errorBody` / `errorText` is an upstream error, not a customer payload:
  // the cause matters and a capped, redacted prefix of it is safe to keep.
  // `message` alone does not claim a compound key — `messageContent` is a
  // chat message's content.
  const namesError = words.some((w) => ERROR_WORDS.has(w) && w !== "message");
  if (last === "stack") return "stack";
  if (
    !namesError &&
    (CONTENT_WORDS.has(last) || CONTENT_KEYS.has(words.join("")))
  ) {
    return "content";
  }
  if (namesError || ERROR_WORDS.has(last)) return "error";
  return "plain";
}

/**
 * `https://mcp.acme.com/tenants/42/sse?key=…` → `https://mcp.acme.com/…`.
 * Userinfo goes with the path: `URL.host` never includes it.
 */
function reduceUrl(text: string): string {
  try {
    const url = new URL(text);
    const rest =
      url.pathname !== "/" || url.search !== "" || url.hash !== "" ? "/…" : "";
    return `${url.protocol}//${url.host}${rest}`;
  } catch {
    return "[redacted-url]";
  }
}

/** Prose punctuation after a URL is not part of it: `see https://x.dev/a, then`. */
function reduceUrlMatch(match: string): string {
  const trailing = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
  return reduceUrl(match.slice(0, match.length - trailing.length)) + trailing;
}

/**
 * A credential-named key whose value is just a web URL — `tokenEndpoint`,
 * `authorizationServer` — names WHERE a credential goes, not the credential.
 * Its origin is safe to keep and is the part that says which server failed.
 */
function isWholeWebUrl(value: unknown): value is string {
  return typeof value === "string" && /^(?:https?|wss?):\/\/\S+$/i.test(value);
}

function capText(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars]`
    : text;
}

function scrubString(s: string): string {
  // The credential registry first, over the whole text. Cutting an absolute
  // URL to its origin already drops its path and query, but the registry is
  // the only pattern that knows a credential PATH, and those arrive relative
  // just as often — a request line (`GET /results/<token>`), a route-error
  // context's `path`, a stack frame quoting a callback's `?code=`. It also
  // strips userinfo from every scheme, not only the web ones below.
  //
  // Then URLs: reducing one to its origin also removes any credential in
  // its userinfo or query, so the narrower patterns below never see half of
  // one. Then the same patterns as the model path, with log-specific
  // replacement strings.
  return scrubCredentialsInText(s)
    .replace(URL_LIKE(), reduceUrlMatch)
    .replace(authHeaderLike(), "$1[redacted]")
    .replace(tokenLike(), "Bearer [redacted-token]")
    .replace(jwtLike(), "[redacted-jwt]")
    .replace(urlBasicAuthLike(), "$1[redacted]@")
    .replace(EMAIL_LIKE, "[redacted-email]")
    .replace(skKeyLike(), "[redacted-secret]")
    .replace(secretParamLike(), "$1[redacted]");
}

/**
 * Free text made safe to ship: credentials, emails and URL paths out, length
 * capped. For text that never sits under a key — an exception's message, a
 * breadcrumb, a line of a sandbox's stderr.
 */
export function scrubLogText(text: string, maxChars = MAX_TEXT_CHARS): string {
  return capText(scrubString(text), maxChars);
}

/**
 * The structure of a value with every value taken out:
 * `{messages: array(2)<{role: string(4), content: string(311)}>, stream: boolean}`.
 *
 * A single string on purpose. Axiom makes a column of every nested key it
 * sees, and the keys of a customer's tool arguments or request body would
 * otherwise mint new columns in the shared dataset. Arrays describe their first
 * element only; depth, key count and total length are bounded.
 */
export function describeShape(value: unknown): string {
  try {
    return capText(shapeOf(value, 0, new Set()), SHAPE_MAX_CHARS);
  } catch {
    // A getter or Proxy trap on a customer object can throw. A logger must
    // never escalate the failure it was reporting.
    return "unreadable";
  }
}

function shapeKey(key: string): string {
  return capText(
    key.replace(EMAIL_LIKE, "[redacted-email]"),
    SHAPE_MAX_KEY_CHARS,
  );
}

function shapeOf(value: unknown, depth: number, path: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value !== "object") return typeof value;
  if (value instanceof Date) return "date";
  if (value instanceof Error) return "error";
  if (ArrayBuffer.isView(value)) return `bytes(${value.byteLength})`;
  if (value instanceof ArrayBuffer) return `bytes(${value.byteLength})`;
  if (path.has(value)) return "circular";
  if (Array.isArray(value)) {
    if (value.length === 0 || depth >= SHAPE_MAX_DEPTH) {
      return `array(${value.length})`;
    }
    path.add(value);
    const item = shapeOf(value[0], depth + 1, path);
    path.delete(value);
    return `array(${value.length})<${item}>`;
  }
  const keys = Object.keys(value);
  if (depth >= SHAPE_MAX_DEPTH) return `object(${keys.length} keys)`;
  path.add(value);
  const fields = keys
    .slice(0, SHAPE_MAX_KEYS)
    .map(
      (key) =>
        `${shapeKey(key)}: ${shapeOf(
          (value as Record<string, unknown>)[key],
          depth + 1,
          path,
        )}`,
    );
  path.delete(value);
  if (keys.length > SHAPE_MAX_KEYS) {
    fields.push(`…+${keys.length - SHAPE_MAX_KEYS}`);
  }
  return `{${fields.join(", ")}}`;
}

/**
 * Scrub a log payload or an error report's context — see the module header.
 *
 * Runs ONCE per payload: a shape summary is itself a string, and shaping it a
 * second time would reduce it to `string(N)`.
 */
export function scrubLogPayload<T>(value: T): T {
  return scrubValue(value, "plain", new WeakSet()) as T;
}

/** An error's identity survives; its text is capped and redacted. */
function scrubError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: scrubLogText(error.message, MAX_ERROR_TEXT_CHARS),
  };
  // Node's system errors (`ECONNRESET`) and most HTTP clients' errors carry
  // these, and they are the part an alert can group on.
  const { code, status, statusCode } = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  for (const [key, field] of Object.entries({ code, status, statusCode })) {
    if (typeof field === "string" || typeof field === "number") {
      out[key] = field;
    }
  }
  if (error.stack) out.stack = scrubLogText(error.stack, MAX_STACK_CHARS);
  return out;
}

function scrubValue(
  value: unknown,
  kind: KeyKind,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  if (kind === "content") return describeShape(value);
  if (typeof value === "string") {
    return scrubLogText(
      value,
      kind === "stack"
        ? MAX_STACK_CHARS
        : kind === "error"
          ? MAX_ERROR_TEXT_CHARS
          : MAX_TEXT_CHARS,
    );
  }
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return scrubError(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return "[buffer]";
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    // An array inherits its key's kind: `upstreamErrors: [...]` is error text.
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((v) => scrubValue(v, kind, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(k)) {
      out[k] = isWholeWebUrl(v) ? reduceUrl(v) : "[redacted]";
      continue;
    }
    out[k] = scrubValue(v, classifyKey(k), seen);
  }
  return out;
}
