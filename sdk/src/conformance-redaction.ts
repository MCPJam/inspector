/**
 * Make a conformance report safe to hand to somebody else.
 *
 * A conformance run is a debugging artifact first: it keeps the raw HTTP
 * exchange so an engineer can see exactly what their server said. That is the
 * right default in the inspector, where the data never leaves the tab of the
 * person who produced it. It is the wrong default the moment a report is
 * PERSISTED BEHIND A LINK, because the OAuth suite completes a real
 * authorization — so the result carries a live access token, a refresh token,
 * the client secret, the `Authorization` headers of every request it made, and
 * the token-exchange bodies. Sharing that link would be sharing credentials for
 * the server being scored.
 *
 * The formatter has always redacted these values on their way to a terminal
 * (`redactSensitiveStrings`), which is the clearest possible statement that they
 * are sensitive. This module is the same judgement applied one layer earlier, to
 * the stored document itself: redaction at display time protects one reader,
 * redaction at write time protects everyone the link ever reaches.
 *
 * Two layers, deliberately overlapping:
 *
 *  1. STRUCTURAL — whole containers whose entire purpose is raw protocol
 *     evidence (`httpAttempts`, `http`, `logs`) and the typed credential bag
 *     (`credentials`) are dropped, not scrubbed. A shared report is a summary:
 *     it needs each check's id, title, status and failure message, and nothing
 *     it drops here is rendered by any result page. Dropping also keeps the
 *     document small, which matters against the 1MB storage bound.
 *  2. KEY-NAME — everything that survives is walked and any value sitting under
 *     a credential-shaped key is replaced, and any URL-shaped string has its
 *     sensitive query parameters replaced. This is the backstop for shapes this
 *     module does not know about, including ones added later.
 *
 * Layer 2 alone would be a blocklist, and a blocklist eventually misses. Layer 1
 * is what makes that acceptable: the containers where unknown-shaped secrets
 * actually accumulate are gone before layer 2 runs.
 *
 * Pure data reasoning — no MCP client, no transport, no Node built-ins — so it
 * is exported from the browser entry alongside the scoring engine.
 */

export const REDACTED = "[REDACTED]";

/**
 * Containers dropped wholesale rather than scrubbed.
 *
 * `logs` carries an untyped `data` payload, and `httpAttempts` / `http` carry
 * complete request and response pairs — headers and bodies both. There is no
 * scrub of those that is easier to trust than their absence.
 */
const DROPPED_KEYS = new Set([
  "httpattempts",
  "http",
  "logs",
  "credentials",
  "headers",
  "rawheaders",
  "customheaders",
]);

/**
 * Keys whose value is a credential, however it is spelled.
 *
 * Compared after stripping non-alphanumerics and lowercasing, so `access_token`,
 * `accessToken` and `Access-Token` are one entry. `tokentype` and `expiresin`
 * are deliberately absent: they describe a token without being one.
 */
const SECRET_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "codeverifier",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "secret",
  "password",
  "privatekey",
  "assertion",
  "clientassertion",
  "registrationaccesstoken",
  "token",
  "bearertoken",
]);

/**
 * `code` is an authorization code when it is a string and a JSON-RPC error
 * number when it is not — and MCP results are full of the latter. Redacting the
 * number would corrupt the very failures a report exists to explain, so this key
 * is redacted only for string values.
 */
const STRING_ONLY_SECRET_KEYS = new Set(["code"]);

/** Query parameters never worth carrying into a shared document. */
const SECRET_QUERY_PARAMS = new Set([
  "code",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "client_secret",
  "code_verifier",
  "assertion",
  "client_assertion",
  "api_key",
  "apikey",
  "key",
  "password",
  "signature",
  "sig",
]);

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function looksSensitiveParam(name: string): boolean {
  const normalized = name.toLowerCase();
  if (SECRET_QUERY_PARAMS.has(normalized)) return true;
  return /(token|secret|password|apikey|api_key|auth|signature)/.test(
    normalized
  );
}

/**
 * Replace sensitive query-parameter VALUES while keeping the parameter names.
 *
 * The names are diagnostic — "this endpoint was called with an api_key" is
 * exactly the kind of thing a reader needs to know — and only the values are
 * dangerous. Returns the input unchanged when it is not a URL, so this is safe
 * to run over arbitrary strings.
 */
export function redactUrlSecrets(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  let touched = false;
  for (const name of Array.from(parsed.searchParams.keys())) {
    if (!looksSensitiveParam(name)) continue;
    parsed.searchParams.set(name, REDACTED);
    touched = true;
  }
  // Userinfo is a credential in the URL itself (`https://user:pass@host/`).
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    touched = true;
  }

  // The FRAGMENT is not part of `searchParams`, and it is where the implicit
  // OAuth flow puts `access_token` — the single most credential-dense place a
  // URL can carry something. Same rule as the query: names kept, values gone.
  if (parsed.hash.length > 1) {
    const fragment = parsed.hash.slice(1);
    // Only treat it as parameters when it actually looks like them; a plain
    // `#section-2` anchor must survive untouched.
    if (/^[^=&]+=[^&]*(?:&[^=&]+=[^&]*)*$/.test(fragment)) {
      const params = new URLSearchParams(fragment);
      let fragmentTouched = false;
      for (const name of Array.from(params.keys())) {
        if (!looksSensitiveParam(name)) continue;
        params.set(name, REDACTED);
        fragmentTouched = true;
      }
      if (fragmentTouched) {
        parsed.hash = `#${params.toString()}`;
        touched = true;
      }
    }
  }

  return touched ? parsed.toString() : value;
}

/**
 * Credentials written into free text, where no object key marks them.
 *
 * The structural sweep only sees values under a key it recognizes. A summary
 * or error string is unstructured by definition — "request failed: {"access_
 * token":"ey…"}" carries a live credential under no key at all — so these
 * patterns are the backstop for the shapes that actually show up in logs.
 */
function redactInlineSecrets(value: string): string {
  return (
    value
      // `Authorization: Bearer …` and friends.
      .replace(
        /((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|dpop)\s+)([^\s,;"']+)/gi,
        `$1${REDACTED}`
      )
      // A scheme + token with no header name in front — how tokens usually get
      // pasted into a message.
      .replace(
        /\b(bearer|dpop)\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
        `$1 ${REDACTED}`
      )
      // Cookie jars are credential stores; the whole line goes.
      .replace(/((?:set-)?cookie\s*[:=]\s*)([^\n\r]+)/gi, `$1${REDACTED}`)
      // JSON fields: `"access_token": "…"`. The key stays legible, which is
      // the diagnostic half.
      .replace(
        /("(?:[a-z_-]*(?:token|secret|password|apikey|api_key|signature)[a-z_-]*)"\s*:\s*")([^"]*)(")/gi,
        `$1${REDACTED}$3`
      )
      // Form-encoded / query-ish fragments that never parsed as a full URL:
      // `client_secret=…&grant_type=…`.
      .replace(
        /\b([a-z_-]*(?:token|secret|password|apikey|api_key|signature)[a-z_-]*)=([^\s&"';,]+)/gi,
        `$1=${REDACTED}`
      )
  );
}

/**
 * Scrub every URL that appears INSIDE a string, not only strings that are
 * entirely a URL.
 *
 * Summaries and error messages are where a redirect actually shows up —
 * "Redirected to https://…?code=…" — and treating only whole-string URLs would
 * walk straight past the single most likely place an authorization code is
 * written down. Trailing sentence punctuation is left outside the match so a
 * URL at the end of a sentence still parses.
 */
function redactEmbeddedUrls(value: string): string {
  // The bracket group admits an IPv6 authority (`http://[::1]:8080/…`) while
  // the rest of the pattern still stops at a bracket, so a URL inside `[…]`
  // prose does not swallow the closing bracket.
  return value.replace(
    /https?:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s"'<>()[\]]*/gi,
    (match) => {
      const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
      const bare = trailing ? match.slice(0, -trailing.length) : match;
      return `${redactUrlSecrets(bare)}${trailing}`;
    }
  );
}

function redactString(value: string): string {
  return redactInlineSecrets(redactEmbeddedUrls(value));
}

/**
 * The scanned server's own URL, as stored and displayed on a shared page.
 *
 * MCP servers are routinely addressed with a key in the query string, and the
 * result page prints this back verbatim — so it gets the same treatment as any
 * other URL in the document.
 */
export function redactSharedServerUrl(url: string): string {
  return redactUrlSecrets(url);
}

function redactValue(value: unknown, depth: number): unknown {
  // Reports are a handful of levels deep; anything beyond this is either
  // pathological or cyclic, and neither belongs in stored evidence.
  if (depth > 24) return REDACTED;

  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (DROPPED_KEYS.has(normalized)) continue;
    if (SECRET_KEYS.has(normalized)) {
      if (entry !== undefined && entry !== null) out[key] = REDACTED;
      continue;
    }
    if (STRING_ONLY_SECRET_KEYS.has(normalized) && typeof entry === "string") {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(entry, depth + 1);
  }
  return out;
}

/**
 * Redact a whole multi-suite report for storage behind a shareable link.
 *
 * Structure-preserving: suites keep their keys, checks keep their ids, titles,
 * statuses and failure messages. What leaves is the raw protocol evidence and
 * anything credential-shaped.
 */
export function redactConformanceReportForSharing<T>(report: T): T {
  return redactValue(report, 0) as T;
}
