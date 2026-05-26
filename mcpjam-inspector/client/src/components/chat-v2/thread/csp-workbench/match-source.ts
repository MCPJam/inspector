/**
 * matchesSourceExpression
 *
 * Returns true when an absolute URL (the violation's `blockedUri`) matches
 * a CSP source-expression entry (one item from `_meta.ui.csp.*` or from the
 * effective allowlist).
 *
 * The CSP source-expression grammar is richer than plain string equality.
 * This helper handles the subset the classifier actually sees in
 * `_meta.ui.csp` and host-effective payloads. Anything ambiguous or
 * malformed returns `false` — the classifier prefers a false-negative
 * (suggest the patch) over a false-positive (claim it's already covered).
 *
 * Spec reference: CSP Level 3 §6.7.2 — source-expression matching.
 */

const KEYWORD_TOKENS = new Set([
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
  "'strict-dynamic'",
  "'unsafe-hashes'",
  "'report-sample'",
]);

const KEYWORD_PREFIXES = ["'nonce-", "'sha256-", "'sha384-", "'sha512-"];

/**
 * Default port for a URL scheme. `null` when unknown — origins with
 * unknown schemes only match by exact string.
 */
function defaultPort(scheme: string): string | null {
  switch (scheme.toLowerCase()) {
    case "http":
    case "ws":
      return "80";
    case "https":
    case "wss":
      return "443";
    default:
      return null;
  }
}

function isKeyword(expr: string): boolean {
  if (KEYWORD_TOKENS.has(expr)) return true;
  return KEYWORD_PREFIXES.some((p) => expr.startsWith(p) && expr.endsWith("'"));
}

interface ParsedUrl {
  scheme: string;
  host: string;
  port: string; // explicit port or default for scheme; "" when unknown
}

function parseUrl(input: string): ParsedUrl | null {
  // Handle keyword-like tokens that show up as blockedUri sometimes ("inline",
  // "eval", "self", "data", "blob"). They aren't URLs — no origin to match.
  if (
    !input ||
    input === "inline" ||
    input === "eval" ||
    input === "self" ||
    input === "data" ||
    input === "blob" ||
    input === "wasm-eval"
  ) {
    return null;
  }

  try {
    const u = new URL(input);
    const scheme = u.protocol.replace(/:$/, "").toLowerCase();
    const host = u.hostname.toLowerCase();
    const port = u.port || defaultPort(scheme) || "";
    return { scheme, host, port };
  } catch {
    return null;
  }
}

/**
 * Match a host against a CSP `host-source` (the host portion of a source
 * expression — no scheme, no port, no path).
 *
 * - `*.example.com` — matches any subdomain (≥1 label); does NOT match the
 *   bare `example.com` (per CSP spec).
 * - `*` alone — matches any host.
 * - Bare `example.com` — exact, case-insensitive.
 */
function matchesHost(host: string, hostPattern: string): boolean {
  const pat = hostPattern.toLowerCase();
  const h = host.toLowerCase();

  if (pat === "*") return true;

  if (pat.startsWith("*.")) {
    const suffix = pat.slice(2);
    if (!suffix) return false;
    // CSP requires at least one label *before* the suffix.
    if (h === suffix) return false;
    return h.endsWith("." + suffix);
  }

  return h === pat;
}

export function matchesSourceExpression(
  origin: string,
  expression: string,
): boolean {
  if (!expression) return false;
  const trimmed = expression.trim();
  if (!trimmed) return false;

  // Keywords (`'self'`, nonces, hashes, etc.) only match inline/eval contexts,
  // never origin URLs. The classifier treats them as non-matching here.
  if (isKeyword(trimmed)) return false;

  const url = parseUrl(origin);
  if (!url) return false;

  // Scheme literal — `data:`, `blob:`, `https:`, `http:`, …
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:$/.test(trimmed)) {
    return url.scheme === trimmed.slice(0, -1).toLowerCase();
  }

  // Otherwise, the expression is a host-source: [scheme://]host[:port][/path]
  let rest = trimmed;
  let exprScheme: string | null = null;

  const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//);
  if (schemeMatch) {
    exprScheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }

  // Strip path — CSP source-expression matching ignores path beyond the host
  // for the purpose of allowlisting an origin.
  const pathIdx = rest.indexOf("/");
  if (pathIdx >= 0) rest = rest.slice(0, pathIdx);

  // Split host:port.
  let exprHost = rest;
  let exprPort: string | null = null;
  const portIdx = rest.lastIndexOf(":");
  // Avoid mis-splitting wildcards like `*.example.com` (no colon) or
  // IPv6 literals (not expected in MCP-Apps CSP, but defensive).
  if (portIdx > 0 && !rest.includes("]")) {
    exprHost = rest.slice(0, portIdx);
    exprPort = rest.slice(portIdx + 1);
  }

  if (!exprHost) return false;

  if (exprScheme && exprScheme !== url.scheme) return false;
  if (!matchesHost(url.host, exprHost)) return false;

  if (exprPort !== null) {
    if (exprPort === "*") return true;
    if (exprPort !== url.port) return false;
  }
  // If the expression had no scheme and the URL is non-default port for its
  // scheme, the CSP spec says the source must specify the port. For the
  // workbench's purposes (developer-facing diagnosis) we accept the match —
  // false negatives would push us to recommend a patch the developer
  // probably already has.

  return true;
}

/** Convenience — returns true when any expression in the list matches. */
export function originAllowedByAny(
  origin: string,
  expressions: readonly string[] | undefined,
): boolean {
  if (!expressions || expressions.length === 0) return false;
  return expressions.some((e) => matchesSourceExpression(origin, e));
}

/**
 * Extract an `https://host[:port]` origin from a possibly-pathful URL.
 * Returns `null` when the input is a keyword token or unparseable.
 *
 * Used by the classifier to produce the suggested-patch entry (we add the
 * origin, not the full URL, to `_meta.ui.csp.*`).
 */
export function extractOrigin(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const scheme = parsed.scheme;
  const host = parsed.host;
  const port = parsed.port;
  const defaultForScheme = defaultPort(scheme);
  const explicitPort = port && port !== defaultForScheme ? `:${port}` : "";
  return `${scheme}://${host}${explicitPort}`;
}
