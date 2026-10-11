/**
 * The scrubbers: one URL (`scrubCredentialUrl`) and free text
 * (`scrubCredentialsInText`). They share a module because they call each
 * other: a query value is scrubbed as text, and a URL inside text is
 * scrubbed as a URL.
 */
import {
  CREDENTIAL_PLACEHOLDER,
  ENCODED_PLACEHOLDER,
  isSecretParamKey,
} from "./registry.ts";
import {
  literalSegment,
  matchCredentialPath,
  PATH_ROUTES,
  safeDecode,
  type CompiledRoute,
} from "./matching.ts";

// ── Query and fragment ─────────────────────────────────────────────────

/** Whether a `?a=b&c=d` / `#a=b` string has any secret key. */
export function hasSecretKey(params: string): boolean {
  const body = params.replace(/^[?#]/, "");
  if (!body) return false;
  return body.split(/[&;]/).some((pair) => {
    const eq = pair.indexOf("=");
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    return key !== "" && isSecretParamKey(key);
  });
}

/**
 * Scrub a `key=value&…` string (no leading `?`/`#`), keeping its spelling:
 * secret keys get the placeholder, other values are scrubbed as text (a
 * `redirect_uri` can itself carry a credential URL).
 */
function scrubParamString(body: string): string {
  // `&` and `;` both separate pairs (`hasSecretKey` agrees); the separators
  // are kept as written.
  return body
    .split(/([&;])/)
    .map((pair, index) => {
      if (index % 2 === 1) return pair;
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      const rawValue = pair.slice(eq + 1);
      if (isSecretParamKey(safeDecode(rawKey.replace(/\+/g, " ")))) {
        return rawValue === "" ? pair : `${rawKey}=${CREDENTIAL_PLACEHOLDER}`;
      }
      const decoded = safeDecode(rawValue.replace(/\+/g, " "));
      const scrubbed = scrubCredentialsInText(decoded);
      // Re-encoded with the placeholder left readable: an encoded
      // `%5Bredacted%5D` is still the placeholder, but a reader (or a leak
      // check) should not have to decode to see it.
      return scrubbed === decoded
        ? pair
        : `${rawKey}=${encodeURIComponent(scrubbed).replace(
            ENCODED_PLACEHOLDER,
            CREDENTIAL_PLACEHOLDER,
          )}`;
    })
    .join("");
}

function scrubPathname(pathname: string): string {
  const match = matchCredentialPath(pathname);
  if (!match || match.segmentStart === undefined) return pathname;
  return `${pathname.slice(0, match.segmentStart)}${CREDENTIAL_PLACEHOLDER}${pathname.slice(match.segmentEnd)}`;
}

function scrubFragment(fragment: string): string {
  // `#/results/<token>` — the legacy hash router puts a path here.
  if (fragment.startsWith("/")) {
    const end = fragment.search(/[?#]/);
    const path = end === -1 ? fragment : fragment.slice(0, end);
    const rest = end === -1 ? "" : fragment.slice(end);
    const scrubbedRest =
      rest.startsWith("?") || rest.startsWith("#")
        ? `${rest[0]}${scrubParamString(rest.slice(1))}`
        : rest;
    return `${scrubPathname(path)}${scrubbedRest}`;
  }
  if (fragment.includes("=")) return scrubParamString(fragment);
  return fragment;
}

// ── One URL ────────────────────────────────────────────────────────────

const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * Split a URL-ish string into its parts by hand rather than through `URL`:
 * the output must keep the input's spelling (relative stays relative, no
 * re-encoding), and any string has to come back, parseable or not.
 */
export function splitUrl(value: string): {
  authority: string;
  path: string;
  query: string;
  fragment: string;
  hasQuery: boolean;
  hasFragment: boolean;
} {
  let rest = value;
  let authority = "";
  const absolute = ABSOLUTE_URL.exec(rest);
  if (absolute) {
    const afterSlashes = absolute[0].length;
    const authorityEnd = rest.slice(afterSlashes).search(/[/?#]/);
    const end = authorityEnd === -1 ? rest.length : afterSlashes + authorityEnd;
    authority = rest.slice(0, end);
    rest = rest.slice(end);
  }
  const hashAt = rest.indexOf("#");
  const fragment = hashAt === -1 ? "" : rest.slice(hashAt + 1);
  if (hashAt !== -1) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return {
    authority,
    path,
    query,
    fragment,
    hasQuery: queryAt !== -1,
    hasFragment: hashAt !== -1,
  };
}

/** `https://user:pass@host` → `https://host`. */
function stripUserinfo(authority: string): string {
  const scheme = ABSOLUTE_URL.exec(authority)?.[0] ?? "";
  const host = authority.slice(scheme.length);
  const at = host.lastIndexOf("@");
  return at === -1 ? authority : `${scheme}${host.slice(at + 1)}`;
}

function looksLikeUrl(value: string): boolean {
  return (
    ABSOLUTE_URL.test(value) ||
    value.startsWith("/") ||
    value.startsWith("?") ||
    value.startsWith("#")
  );
}

function scrubUrlUnsafe(value: string): string {
  const parts = splitUrl(value);
  return `${stripUserinfo(parts.authority)}${scrubPathname(parts.path)}${
    parts.hasQuery ? `?${scrubParamString(parts.query)}` : ""
  }${parts.hasFragment ? `#${scrubFragment(parts.fragment)}` : ""}`;
}

/**
 * Remove every credential from one URL: the secret segment of a registered
 * route, the value of every secret query/fragment key, and userinfo. Works on
 * absolute URLs (any scheme, `mcpjam://` included), protocol-relative ones,
 * and relative paths; keeps everything else as written.
 *
 * Never throws. A value that is not URL-shaped is scrubbed as free text.
 */
export function scrubCredentialUrl(value: string): string {
  if (typeof value !== "string" || value === "") return value;
  try {
    if (!looksLikeUrl(value)) return scrubCredentialsInText(value);
    const scrubbed = scrubUrlUnsafe(value);
    return scrubbed === value ? value : scrubbed;
  } catch {
    return safeTextFallback(value);
  }
}

/** Last resort for a value the URL path could not handle. */
function safeTextFallback(value: string): string {
  try {
    return scrubCredentialsInText(value);
  } catch {
    return CREDENTIAL_PLACEHOLDER;
  }
}

// ── Free text ──────────────────────────────────────────────────────────

/** A slash, raw or percent-encoded (URLs nested in other URLs' queries). */
const SLASH = "(?:/|%2[Ff])";
/** A segment inside free text: stops at the usual URL and prose delimiters. */
const TEXT_SEGMENT = `((?!:|%5[Bb])(?:(?!%2[Ff]|%3[Ff]|%23)[^/?#\\s"'<>\\\\()[\\]\`|,;])+)`;

interface TextPattern {
  regex: RegExp;
  reserved: readonly string[];
}

function textPatternFor(compiled: CompiledRoute): TextPattern {
  const segments = compiled.route.pattern.split("/").filter(Boolean);
  const source = segments
    .map((segment) =>
      segment.startsWith(":") ? TEXT_SEGMENT : literalSegment(segment),
    )
    .join(SLASH);
  // No boundary before the leading slash: in prose the route follows a host
  // (`app.mcpjam.com/results/…`) as often as a space, and the slash itself is
  // what keeps `/foo-results/…` out.
  return {
    regex: new RegExp(`${SLASH}${source}`, "gi"),
    reserved: compiled.route.reserved ?? [],
  };
}

const TEXT_PATH_PATTERNS: readonly (TextPattern & {
  compiled: CompiledRoute;
})[] = PATH_ROUTES.map((compiled) => ({
  ...textPatternFor(compiled),
  compiled,
}));

/** An absolute URL inside prose. Same shape the SDK's conformance scrubber uses. */
const EMBEDDED_URL =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s"'<>()[\]`]*/gi;

/** Trailing sentence punctuation a URL in prose should not swallow. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** An error or status code, not a secret: `ENOENT`, `ERR_TIMEOUT`, `500`. */
const STATUS_CODE_VALUE = /^(?:[A-Z][A-Z0-9_]*|\d{1,4})[.,;:!?)]*$/;

/**
 * `?code=…`, `&state=…`, `#access_token=…`, and their percent-encoded
 * spellings (a callback URL quoted inside another URL's query). Also at the
 * very start of the text, where a form body (`code=…&state=…`) begins.
 */
const TEXT_PARAM =
  /((?:^|[?&#;]|%3[Ff]|%26|%23)\s*)((?:[A-Za-z0-9_.\-[\]]|%(?!3[Ff]|26|23|3[Dd])[0-9A-Fa-f]{2})+)((?:=|%3[Dd]))((?:(?!%26|%23)[^&#;\s"'<>\\`])*)/g;

/**
 * Userinfo on a protocol-relative URL in prose (`failed //user:pw@host/…`).
 * Absolute URLs lose theirs through `EMBEDDED_URL`; this is the scheme-less
 * spelling, anchored at a boundary so a `//` inside a path does not count.
 */
const PROTOCOL_RELATIVE_USERINFO =
  /(^|[\s"'(<=,[])\/\/[^\s/?#@"'<>()[\]`]+@(?=[^\s/?#@])/g;

/** A whole value that is one relative or protocol-relative URL. */
const WHOLE_RELATIVE_URL = /^[/?#]\S*$/;

function scrubTextPaths(text: string): string {
  let out = text;
  for (const pattern of TEXT_PATH_PATTERNS) {
    const { segmentGroup, paramNames } = pattern.compiled;
    out = out.replace(pattern.regex, (match: string, ...groups: unknown[]) => {
      const secret = groups.slice(0, paramNames.length)[segmentGroup - 1];
      if (
        typeof secret !== "string" ||
        pattern.reserved.includes(safeDecode(secret).toLowerCase())
      ) {
        return match;
      }
      // Every registered secret is its template's last segment, so it is the
      // tail of the match.
      return `${match.slice(0, match.length - secret.length)}${CREDENTIAL_PLACEHOLDER}`;
    });
  }
  return out;
}

function scrubTextParams(text: string, depth = 0): string {
  return text.replace(
    TEXT_PARAM,
    (match, lead: string, key: string, eq: string, value: string) => {
      if (
        value === "" ||
        value.startsWith(CREDENTIAL_PLACEHOLDER) ||
        /^%5Bredacted%5D/i.test(value)
      ) {
        return match;
      }
      // At the very start of the text a pair is a credential too
      // (`token=sk_…`, `code=4/0A…`), unless it is a form-less log line that
      // opens with an error or status code (`code=ENOENT`, `code=500`). Only
      // `code` names one; `password=HUNTER2` is still a password.
      // Twice: a key quoted inside another URL's query is encoded twice
      // (`%3Fco%2564e%3D…`).
      const decodedKey = safeDecode(safeDecode(key));
      const statusCode =
        lead === "" &&
        depth === 0 &&
        !text.includes("&") &&
        decodedKey.trim().toLowerCase() === "code" &&
        STATUS_CODE_VALUE.test(value);
      if (!statusCode && isSecretParamKey(decodedKey)) {
        // Sentence punctuation after a value in prose is not part of it.
        const trailing = TRAILING_PUNCTUATION.exec(value)?.[0] ?? "";
        return `${lead}${key}${eq}${CREDENTIAL_PLACEHOLDER}${trailing}`;
      }
      // A non-secret value can be a whole URL, percent-encoded
      // (`redirect=https%3A%2F%2F…%3Fcode%3D…`); its own parameters are
      // inside it. Bounded: each level is a strict substring.
      if (depth >= 4) return match;
      const inner = scrubTextParams(value, depth + 1);
      return inner === value ? match : `${lead}${key}${eq}${inner}`;
    },
  );
}

/**
 * Remove credentials from free text: every absolute URL in it is scrubbed as
 * a URL, every registered credential path (with or without a host, raw or
 * percent-encoded) loses its secret segment, and every `?key=` / `&key=` /
 * `#key=` with a secret key loses its value.
 *
 * Never throws; text without credentials comes back identical.
 */
export function scrubCredentialsInText(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  // Every shape this removes needs one of these: a path (`/`), a parameter
  // (`=`), an encoded form (`%`) or a scheme (`:`). Most strings an event
  // carries — ids, enums, names, counts — have none, and skip the scans.
  if (!MAY_HOLD_CREDENTIAL.test(text)) return text;
  try {
    // A value that is one relative URL (`/api/x?co%64e=…`, `//user:pw@host`)
    // goes through the URL parser, as an absolute one does below.
    let out = WHOLE_RELATIVE_URL.test(text) ? scrubUrlUnsafe(text) : text;
    out = out.replace(EMBEDDED_URL, (url) => {
      const trailing = TRAILING_PUNCTUATION.exec(url)?.[0] ?? "";
      const core = trailing ? url.slice(0, -trailing.length) : url;
      return `${scrubUrlUnsafe(core)}${trailing}`;
    });
    out = out.replace(PROTOCOL_RELATIVE_USERINFO, "$1//");
    out = scrubTextPaths(out);
    out = scrubTextParams(out);
    return out;
  } catch {
    return CREDENTIAL_PLACEHOLDER;
  }
}

const MAY_HOLD_CREDENTIAL = /[/=%:]/;

/** Whether a string still carries a credential this module would scrub. */
export function containsCredential(text: string): boolean {
  return scrubCredentialsInText(text) !== text;
}
