/**
 * Getting an agent-minted permalink back after the WorkOS round trip.
 *
 * The most important recipient of a permalink is often signed OUT: someone
 * pastes `https://app.mcpjam.com/servers/<id>?project=<demo>` into a fresh
 * browser. Before this module the app signed them in, AuthKit returned them to
 * `/callback`, and `/callback` renders Connect — so the path AND the
 * `?project=` scope were both gone by the time they were authenticated. They
 * landed on whichever project their picker defaulted to, which is precisely
 * the wrong-project landing the permalink work exists to end, reintroduced at
 * the last step.
 *
 * Modelled on `server-connection-handoff.ts`'s sign-in return, and
 * deliberately the same shape: the PATH never crosses the network, only a
 * nonce does. AuthKit round-trips `state` through the authorization server, so
 * anything put there is visible to it and in the user's URL bar; the path is
 * kept in same-origin `sessionStorage` and re-validated as same-origin on the
 * way out.
 *
 * A permalink carries no credential, so nothing here is a security boundary —
 * it is a correlator, and the failure mode of losing it is landing on the app
 * shell, exactly as today.
 */
import {
  captureCurrentReturnPath,
  normalizeReturnTargetPath,
  routePaths,
} from "./app-navigation";

/** The key AuthKit's round-tripped `state` carries the nonce under. */
export const PERMALINK_SIGN_IN_STATE_KEY = "mcpjamPermalinkReturn";

const STORAGE_KEY = "mcpjam:permalink-signin-return";

/**
 * Long enough for a real sign-in — including an SSO hop, a password reset, or
 * an email verification detour — and short enough that a tab left open for a
 * day does not redirect a LATER sign-in to a link the user has forgotten.
 */
const TTL_MS = 30 * 60 * 1000;

interface StoredReturn {
  path: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Reduce a candidate to a safe same-origin app path, or refuse it.
 *
 * `normalizeReturnTargetPath` already refuses an unknown first segment; this
 * adds the origin check, because the value round-trips through storage and an
 * absolute URL there would turn a sign-in into an open redirect.
 */
function safeReturnPath(path: string, origin: string): string | null {
  const trimmed = path?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(trimmed, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;
  // Checked on the RESOLVED pathname, before normalization: `/` normalizes to
  // `/servers` (the default tab), so a post-normalization check would happily
  // store a round trip that returns nowhere in particular. `/callback` would
  // loop back into the handler that is reading this.
  if (resolved.pathname === "/" || resolved.pathname === routePaths.callback) {
    return null;
  }
  // A SENTINEL fallback rather than `/servers`: normalization answers with
  // its fallback for an unrecognized first segment, and `/servers?project=…`
  // is itself a legitimate permalink — so a real fallback value would be
  // indistinguishable from a real target. Refusing here means the user signs
  // in with no return and lands on the shell, which is what would have
  // happened anyway; silently rewriting their URL to a different screen is
  // not.
  const UNROUTABLE = "/__unroutable__";
  const normalized = normalizeReturnTargetPath(
    `${resolved.pathname}${resolved.search}`,
    UNROUTABLE,
  );
  if (normalized === UNROUTABLE) return null;
  return normalized;
}

function mintNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // A correlator, never a capability: the marker it points at is already
    // scoped to this tab and holds no token.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Remember where this sign-in started, and return the nonce to hand AuthKit's
 * `state`.
 *
 * `null` means "sign in without a return" — an unsafe path, or storage the
 * browser refuses (a locked-down private window). The user then lands on the
 * app shell, which is the behaviour that shipped before this existed.
 */
export function rememberPermalinkSignInReturn(
  path: string | null | undefined,
  origin: string,
  now: number = Date.now(),
): string | null {
  if (!path) return null;
  const safe = safeReturnPath(path, origin);
  if (!safe) return null;
  const nonce = mintNonce();
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ path: safe, nonce, expiresAt: now + TTL_MS }),
    );
    return nonce;
  } catch {
    return null;
  }
}

/**
 * Consume the return path for this nonce, or `null`.
 *
 * ALWAYS clears the marker, including on a mismatch: a stale marker would
 * otherwise capture the NEXT sign-in in this tab and send it somewhere the
 * user did not ask to go.
 */
export function takePermalinkSignInReturn(
  nonce: unknown,
  origin: string,
  now: number = Date.now(),
): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw || typeof nonce !== "string" || !nonce) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredReturn>;
    if (
      typeof parsed?.path !== "string" ||
      typeof parsed?.nonce !== "string" ||
      !Number.isFinite(parsed?.expiresAt)
    ) {
      return null;
    }
    if (parsed.expiresAt! <= now) return null;
    if (parsed.nonce !== nonce) return null;
    // Re-validated on the way OUT as well as in: what is parsed here is
    // whatever is in storage now, not necessarily what this build wrote.
    return safeReturnPath(parsed.path, origin);
  } catch {
    return null;
  }
}

/**
 * The `signIn()` options that bring the current page back afterwards.
 *
 * Call sites pass this instead of calling `signIn()` bare:
 * `signIn(permalinkSignInOptions())`. It is a no-op object when there is
 * nothing worth returning to (the app root) or storage is unavailable, so a
 * call site never has to branch.
 */
export function permalinkSignInOptions(): {
  state?: Record<string, string>;
} {
  if (typeof window === "undefined") return {};
  const nonce = rememberPermalinkSignInReturn(
    captureCurrentReturnPath(),
    window.location.origin,
  );
  return nonce ? { state: { [PERMALINK_SIGN_IN_STATE_KEY]: nonce } } : {};
}
