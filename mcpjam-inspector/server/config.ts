/**
 * Server configuration constants
 */

// Server port - can be overridden via environment variable
export const SERVER_PORT = process.env.SERVER_PORT
  ? parseInt(process.env.SERVER_PORT, 10)
  : 6274;

// Server hostname
export const SERVER_HOSTNAME =
  process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";

// Local server address for tunneling
export const LOCAL_SERVER_ADDR = `http://localhost:${SERVER_PORT}`;

// Hosted mode for cloud deployments (Railway, etc.)
// Uses VITE_ prefix so the same variable works for both server and client build
export const HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE === "true";

export const NON_PROD_LOCKDOWN = process.env.MCPJAM_NONPROD_LOCKDOWN === "true";

/**
 * Feed model-visible widget→host tool calls (recorded by Interact steps) to the
 * eval model as a per-turn system-prompt addendum, so the model reasons over a
 * widget interaction on its next turn (the headless analogue of Playground's
 * browser-side addToolOutput + auto-continue). Reuses the same server-side
 * mechanism Playground uses for `ui/update-model-context`. OFF by default: it
 * changes what the model sees, so existing eval verdicts shouldn't shift until a
 * suite opts in. App-only (`visibility:["app"]`) calls are never included.
 */
export const EVAL_WIDGET_MODEL_CONTEXT =
  process.env.MCPJAM_EVAL_WIDGET_MODEL_CONTEXT === "true";


export const EMPLOYEE_EMAIL_DOMAINS = (
  process.env.MCPJAM_EMPLOYEE_EMAIL_DOMAINS ?? ""
)
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter((domain) => domain.length > 0);

export function isAllowedEmployeeEmail(
  email: string | null | undefined
): boolean {
  if (!email || EMPLOYEE_EMAIL_DOMAINS.length === 0) {
    return false;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex === -1) {
    return false;
  }

  const emailDomain = normalizedEmail.slice(atIndex + 1);
  return EMPLOYEE_EMAIL_DOMAINS.includes(emailDomain);
}

// Exact origins allowed for hosted web routes and CORS
export const WEB_ALLOWED_ORIGINS = (process.env.WEB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const CLIENT_PORT = process.env.CLIENT_PORT || "5173";

const DEFAULT_CORS_ORIGINS = [
  `http://localhost:${CLIENT_PORT}`, // Vite dev server
  "http://localhost:8080", // Electron renderer dev server
  `http://localhost:${SERVER_PORT}`, // Hono server
  `http://127.0.0.1:${SERVER_PORT}`, // Hono server production
  "https://staging.mcpjam.com", // Hosted deployment
];

// CORS origins:
// - Hosted mode: exact allowlist from WEB_ALLOWED_ORIGINS (if provided).
// - Local mode: defaults + WEB_ALLOWED_ORIGINS (to support local testing with hosted origins).
export const CORS_ORIGINS =
  HOSTED_MODE && WEB_ALLOWED_ORIGINS.length > 0
    ? WEB_ALLOWED_ORIGINS
    : Array.from(new Set([...DEFAULT_CORS_ORIGINS, ...WEB_ALLOWED_ORIGINS]));

// Hosted web route timeouts (ms)
export const WEB_CONNECT_TIMEOUT_MS = 10_000;
export const WEB_CALL_TIMEOUT_MS = 30_000;
export const WEB_STREAM_TIMEOUT_MS = 120_000;

// ── Hosted elicitation (MCP 2025-11-25) ─────────────────────────────────────
// An elicitation blocks a `tools/call` on a HUMAN, so these are human-scale.
// They do not extend how long a *server* may take to respond: the SDK's
// elicitation-aware timeout only stops the clock while an elicitation is
// pending (see `elicitationTimeoutExtensionMs`), so a hung server still dies
// at WEB_STREAM_TIMEOUT_MS of its own activity.

/** How long the user has to answer a form before we resolve `{action:"cancel"}`. */
export const ELICITATION_FORM_TTL_MS = 5 * 60_000;
/** How long the user has to consent to (or decline) opening a URL. */
export const ELICITATION_URL_CONSENT_TTL_MS = 2 * 60_000;
/** Convex rendezvous poll cadence while a tool call is blocked. */
export const ELICITATION_POLL_INTERVAL_MS = 1_000;
/** Jitter added per poll so replicas don't synchronize (scheduled-evals idiom). */
export const ELICITATION_POLL_JITTER_MS = 250;
/** Consecutive poll transport failures tolerated before resolving `cancel`. */
export const ELICITATION_POLL_MAX_FAILURES = 5;
/**
 * Deadline for a single Convex service-route call (poll/ack/cancel). These are
 * tiny reads/writes; anything slower is a stall. Unbounded, a hung Convex would
 * park the poll loop forever — the tool call would outlive its TTL and
 * end-of-stream cleanup would block behind it.
 */
export const ELICITATION_SERVICE_ROUTE_TIMEOUT_MS = 10_000;
/**
 * Total suspended-time budget granted to ONE tool call across all of its
 * sequential elicitations. Slack over the longest single TTL so a form answered
 * at the last second still lands.
 */
export const ELICITATION_TIMEOUT_EXTENSION_MS = ELICITATION_FORM_TTL_MS + 30_000;

// ── Hosted MRTR continuation transport (MCP 2026-07-28 §12.5) ────────────────
//
// A suspended `input_required` operation is durably parked in Convex (PR3a) and
// resumed on a fresh request. Unlike legacy elicitation the worker does NOT
// block, so the TTL can be generous — it bounds how long a human has to answer
// across a whole round before the continuation is expired and scrubbed.
/** How long a suspended MRTR continuation survives awaiting a human answer. */
export const MRTR_CONTINUATION_TTL_MS = 10 * 60_000;
/** Lease TTL for a single resume claim; a resume that stalls past this is swept. */
export const MRTR_CONTINUATION_LEASE_TTL_MS = 60_000;
/** Deadline for a single Convex continuation-store call. */
export const MRTR_CONTINUATION_ROUTE_TIMEOUT_MS = 10_000;
/**
 * Hard byte cap on the serialized opaque `resumeState` blob (the encoded
 * `MrtrOperationState`). Oversized state is rejected at the codec, never
 * silently truncated — a truncated blob would deserialize to a corrupt
 * operation and re-drive the wrong request.
 */
export const MRTR_RESUME_STATE_MAX_BYTES = 128 * 1024;
/** Per-field cap for the safe display carried to the browser (message, schema). */
export const MRTR_DISPLAY_FIELD_MAX_BYTES = 16 * 1024;
/** Cap on a single browser-submitted response's serialized content. */
export const MRTR_RESPONSE_CONTENT_MAX_BYTES = 64 * 1024;

// Hosted app origin the LOCAL inspector server forwards XAA hosted-issuer
// mint requests to (server-to-server; hosted CORS blocks the browser from
// calling it directly). Override for staging. Never derived from a request.
export const MCPJAM_HOSTED_ORIGIN =
  process.env.MCPJAM_HOSTED_ORIGIN?.replace(/\/+$/, "") ||
  "https://app.mcpjam.com";

// Allowed hosts for token delivery in hosted mode (comma-separated)
// These hosts will be allowed to receive session tokens in addition to localhost
export const ALLOWED_HOSTS = process.env.MCPJAM_ALLOWED_HOSTS
  ? process.env.MCPJAM_ALLOWED_HOSTS.split(",").map((h) =>
      h.trim().toLowerCase()
    )
  : [];

// Vanity domains whose root path ("/") should land on the host-compare
// showcase ("Can I use" for MCP hosts). Override via env if more are added.
export const CANIUSE_LANDING_HOSTS = new Set(
  (process.env.CANIUSE_LANDING_HOSTS ?? "caniuse.dev,www.caniuse.dev")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0),
);
