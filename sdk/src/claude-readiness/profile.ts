/**
 * The Claude host's own constants — the values a server has to match, as
 * opposed to the requirements it has to satisfy.
 *
 * Kept apart from the checks so that a Claude-side change (a new callback URL,
 * a different content host) is one edit to a named constant rather than a
 * grep through check bodies for a string literal.
 *
 * Pure data. Safe from the browser entry.
 */

import { claudePolicySource } from "./manifest.js";

/**
 * The redirect URIs Claude sends users back to.
 *
 * A server that allowlists redirect URIs must accept these EXACTLY, and the
 * list is versioned rather than pattern-matched: "any claude.ai URL" is not
 * what a conforming allowlist should contain, and a check that accepted a
 * pattern would pass a server that is about to fail in production.
 */
export const CLAUDE_CALLBACK_URLS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

/**
 * Loopback redirect URIs compare with the PORT IGNORED.
 *
 * RFC 8252 §7.3: a native client's loopback redirect gets an ephemeral port,
 * so an authorization server that compares `http://127.0.0.1:49152/callback`
 * byte-for-byte against a registered `http://127.0.0.1/callback` rejects every
 * real attempt. This flag exists so the check states the rule it is applying
 * instead of hard-coding a port nobody can predict.
 */
export const CLAUDE_LOOPBACK_REDIRECT_IGNORES_PORT = true;

/**
 * The content host an MCP App's `ui.domain` must name when it sets one.
 *
 * The domain is derived, not chosen: `sha256(<exact connector URL>)`, first 32
 * hex characters, then this suffix. "Exact" is doing real work — a trailing
 * slash, a different scheme, or a normalised port produces a different digest
 * and therefore a domain Claude will not serve, which is why the check
 * compares against the URL as entered rather than a canonicalised one.
 */
export const CLAUDE_APP_CONTENT_DOMAIN_SUFFIX = ".claudemcpcontent.com";

/** Hex characters of the digest that go into the label. */
export const CLAUDE_APP_CONTENT_DOMAIN_HASH_LENGTH = 32;

/**
 * The MIME profile a modern MCP App resource must declare.
 *
 * `text/html` alone is not it: the profile parameter is what tells the host
 * the payload is an app rather than a document, and a mismatch is a failure in
 * the modern-apps lane rather than a style note.
 */
export const CLAUDE_APP_HTML_MIME = "text/html;profile=mcp-app";

/**
 * Latency budgets, in milliseconds.
 *
 * These are grading thresholds, not hard timeouts. Every check that uses them
 * samples and reports raw timings in its details: a shared CI node is a noisy
 * place to measure, and a single slow sample must never be the whole verdict.
 */
export const CLAUDE_LATENCY_BUDGETS = {
  /** Time to a usable `tools/list` after connect. */
  toolListingMs: 5_000,
  /** Time to first byte on the MCP endpoint. */
  handshakeMs: 3_000,
  /** How long a widget may take to reach first paint. */
  widgetFirstPaintMs: 3_000,
} as const;

/**
 * Minimum viewport width an MCP App must remain usable at, and the minimum
 * touch-target edge, from the design guidelines.
 */
export const CLAUDE_APP_DESIGN_BUDGETS = {
  minViewportWidthPx: 320,
  minTouchTargetPx: 44,
} as const;

/**
 * Listing-field bounds from the submission form. Deterministic to check, which
 * is exactly why they belong to the directory-policy lane and not to a
 * heuristic one.
 */
export const CLAUDE_SUBMISSION_LIMITS = {
  nameMaxLength: 100,
  taglineMaxLength: 55,
  descriptionMaxLength: 2_000,
  categoriesMin: 1,
  categoriesMax: 5,
  screenshotsMin: 3,
  screenshotsMax: 5,
  screenshotMinWidthPx: 1_000,
  /** MCP tool names Claude will accept. */
  toolNameMaxLength: 64,
} as const;

/**
 * The whole profile as one object, with its provenance attached, so a surface
 * can render "graded against Claude's published host profile, snapshot
 * 2026-08-19" without reassembling it from loose constants.
 */
export const CLAUDE_HOST_PROFILE = {
  callbackUrls: CLAUDE_CALLBACK_URLS,
  loopbackRedirectIgnoresPort: CLAUDE_LOOPBACK_REDIRECT_IGNORES_PORT,
  appContentDomainSuffix: CLAUDE_APP_CONTENT_DOMAIN_SUFFIX,
  appContentDomainHashLength: CLAUDE_APP_CONTENT_DOMAIN_HASH_LENGTH,
  appHtmlMime: CLAUDE_APP_HTML_MIME,
  latencyBudgets: CLAUDE_LATENCY_BUDGETS,
  appDesignBudgets: CLAUDE_APP_DESIGN_BUDGETS,
  submissionLimits: CLAUDE_SUBMISSION_LIMITS,
  source: claudePolicySource("directory", "Host profile constants"),
} as const;
