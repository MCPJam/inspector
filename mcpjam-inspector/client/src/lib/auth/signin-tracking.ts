/**
 * `signin_started`, then exactly one of `signin_completed` or `signin_failed`,
 * for every WorkOS sign-in or sign-up attempt.
 *
 * A started attempt usually ends on a different page load: the browser leaves
 * for WorkOS and comes back on the redirect path. The attempt is kept in
 * localStorage (sessionStorage does not reach the desktop app's callback
 * window) and settled once AuthKit has finished loading on the next load.
 * An attempt with no callback for 30 minutes is reported as abandoned.
 */
import posthog from "posthog-js";
import { track } from "@/lib/analytics";
import { detectPlatform, isPostHogDisabled } from "@/lib/PosthogUtils";
import { isRecord } from "@/lib/host-capabilities";

export type SignInIntent = "sign_in" | "sign_up";
/** Where the attempt began. Closed values, mirrored in the strict catalog. */
export type SignInLocation = "app" | "session-refresh" | "promo_redemption";
export type SignInFailureReason =
  | "insecure_origin"
  | "start_error"
  | "callback_error"
  | "code_exchange_failed"
  | "abandoned";
export type SignInPlatform = "web" | "desktop" | "npx";

export interface SignInAttempt {
  intent: SignInIntent;
  location: SignInLocation;
}

interface PendingSignIn extends SignInAttempt {
  /** Tabs share the marker, so an attempt acts on it only while this matches. */
  id: string;
  startedAt: number;
}

/** What the page load carried when it arrived, read before AuthKit cleans the URL. */
export type SignInLoad = "code_callback" | "error_callback" | "other";

export const PENDING_SIGN_IN_STORAGE_KEY = "mcpjam_signin_pending_v1";
export const SIGN_IN_ABANDONED_AFTER_MS = 30 * 60 * 1000;

function isIntent(value: unknown): value is SignInIntent {
  return value === "sign_in" || value === "sign_up";
}

function isLocation(value: unknown): value is SignInLocation {
  return (
    value === "app" ||
    value === "session-refresh" ||
    value === "promo_redemption"
  );
}

/** Docker serves the same browser app as hosted web, so it counts as web. */
export function signInPlatform(
  platform: string = detectPlatform(),
): SignInPlatform {
  if (platform === "mac" || platform === "win" || platform === "electron")
    return "desktop";
  if (platform === "npm") return "npx";
  return "web";
}

function readPending(): PendingSignIn | null {
  try {
    const raw = localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      isIntent(parsed.intent) &&
      isLocation(parsed.location) &&
      typeof parsed.id === "string" &&
      typeof parsed.startedAt === "number"
    ) {
      return {
        intent: parsed.intent,
        location: parsed.location,
        id: parsed.id,
        startedAt: parsed.startedAt,
      };
    }
    // An unrecognized marker cannot be settled; drop it.
    localStorage.removeItem(PENDING_SIGN_IN_STORAGE_KEY);
    return null;
  } catch {
    // Blocked storage or a corrupt marker: there is no attempt to settle.
    return null;
  }
}

function writePending(pending: PendingSignIn | null): boolean {
  try {
    if (pending) {
      localStorage.setItem(PENDING_SIGN_IN_STORAGE_KEY, JSON.stringify(pending));
    } else {
      localStorage.removeItem(PENDING_SIGN_IN_STORAGE_KEY);
    }
    return true;
  } catch {
    // Without storage the attempt is only counted as started.
    return false;
  }
}

// An attempt this page started without storing its marker. No other tab can
// see it, so a failure before the redirect still belongs to it.
let unstoredAttemptId: string | null = null;

function takePending(): PendingSignIn | null {
  const pending = readPending();
  if (pending) writePending(null);
  return pending;
}

/**
 * The pending marker exists only for analytics, so it is not written when
 * nothing would be sent: telemetry turned off, or a page that never
 * initializes PostHog (the standalone `/connect/server/<token>` root).
 */
function isTrackingOff(): boolean {
  return (
    isPostHogDisabled || !posthog.__loaded || posthog.has_opted_out_capturing()
  );
}

function properties({ intent, location }: SignInAttempt) {
  return { location, intent, signin_platform: signInPlatform() };
}

function fail(attempt: SignInAttempt, reason: SignInFailureReason): void {
  track("signin_failed", { ...properties(attempt), reason });
}

/**
 * Opens an attempt and returns its id, or null when tracking is off. An
 * earlier one that never came back is settled first.
 */
export function trackSignInStarted(attempt: SignInAttempt): string | null {
  if (isTrackingOff()) return null;
  const previous = takePending();
  if (previous) fail(previous, "abandoned");
  // Not `crypto.randomUUID`: it is missing on the insecure LAN origins whose
  // attempts fail with `insecure_origin`.
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const stored = writePending({ ...attempt, id, startedAt: Date.now() });
  unstoredAttemptId = stored ? null : id;
  track("signin_started", properties(attempt));
  return id;
}

/**
 * Ends an attempt that never left for WorkOS. Once another tab has started an
 * attempt, this one was already reported abandoned and the marker is not its.
 */
export function trackSignInFailedBeforeRedirect(
  attemptId: string | null,
  attempt: SignInAttempt,
  reason: "insecure_origin" | "start_error",
): void {
  if (attemptId === null) return;
  if (attemptId === unstoredAttemptId) {
    unstoredAttemptId = null;
  } else if (readPending()?.id === attemptId) {
    writePending(null);
  } else {
    return;
  }
  fail(attempt, reason);
}

export function readSignInLoad(href: string, redirectUri: string): SignInLoad {
  const url = new URL(href);
  const redirectPath = new URL(redirectUri, url.origin).pathname;
  if (url.pathname !== redirectPath && url.pathname !== `${redirectPath}/`)
    return "other";
  if (url.searchParams.has("error")) return "error_callback";
  if (url.searchParams.has("code")) return "code_callback";
  return "other";
}

/**
 * Settles the stored attempt once AuthKit has loaded. AuthKit calls
 * `onRedirectCallback` only on success and logs a failed code exchange
 * without reporting it, so the outcome is read from whether a user exists.
 */
export function settleSignInOnLoad(
  load: SignInLoad,
  signedIn: boolean,
  now: number = Date.now(),
): void {
  if (isTrackingOff()) {
    // A callback still ends its attempt while the user is opted out, or a
    // later opt-in would report it abandoned. Before PostHog loads, the
    // marker is left for SignInAttemptSettler to settle.
    if (load !== "other" && posthog.__loaded) writePending(null);
    return;
  }
  if (load === "other") {
    const pending = readPending();
    if (pending && now - pending.startedAt >= SIGN_IN_ABANDONED_AFTER_MS) {
      writePending(null);
      fail(pending, "abandoned");
    }
    return;
  }
  const pending = takePending();
  if (!pending) return;
  if (load === "error_callback") fail(pending, "callback_error");
  else if (signedIn) track("signin_completed", properties(pending));
  else fail(pending, "code_exchange_failed");
}
