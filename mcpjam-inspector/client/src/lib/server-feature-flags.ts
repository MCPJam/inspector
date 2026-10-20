import {
  pickClientFeatureFlags,
  type ClientFeatureFlagValues,
} from "../../../shared/client-feature-flags";
import { getCachedGuestSession } from "./guest-session";
import {
  isSessionRevokedResponse,
  notifySessionRevoked,
} from "./auth/session-revoked";
import { detectPlatform } from "./PosthogUtils";
import { POSTHOG_TAB_STORAGE_KEY } from "./posthog-tab-storage";

/**
 * PostHog flag values come from our own server (`GET /api/web/flags`), which
 * evaluates the allowlist in shared/client-feature-flags.ts. posthog-js is
 * bootstrapped with them at init and runs with remote flag loading off
 * (`getPostHogOptions`), then gets a fresh set whenever the PostHog identity
 * changes (`refreshServerFeatureFlagsForActor`). (MJ-015)
 *
 * Bootstrap failures return no values. An actor refresh clears stale values
 * when it cannot obtain the new actor's evaluation.
 */

const FLAGS_PATH = "/api/web/flags";

/** The first render waits at most this long for flag values. */
export const BOOTSTRAP_FLAGS_TIMEOUT_MS = 1_500;
const REFRESH_FLAGS_TIMEOUT_MS = 10_000;

export async function fetchServerFeatureFlags(
  options: {
    /** The anonymous PostHog id; ignored by the server when `bearer` is set. */
    distinctId?: string | null;
    bearer?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<ClientFeatureFlagValues | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REFRESH_FLAGS_TIMEOUT_MS,
  );
  try {
    const params = new URLSearchParams({ platform: detectPlatform() });
    if (options.distinctId) params.set("distinct_id", options.distinctId);
    const response = await fetch(`${FLAGS_PATH}?${params.toString()}`, {
      headers: options.bearer
        ? { Authorization: `Bearer ${options.bearer}` }
        : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      // The access token's session was signed out elsewhere (MJ-011): the
      // flags stay as they are, and the tab signs out.
      if (await isSessionRevokedResponse(response)) notifySessionRevoked();
      return null;
    }
    const body = (await response.json()) as { flags?: unknown } | null;
    return pickClientFeatureFlags(body?.flags);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Read only this tab's identity, using the same storage/name as posthog-js.
function readPersistedPostHogDistinctId(): string | null {
  try {
    const raw = window.sessionStorage.getItem(POSTHOG_TAB_STORAGE_KEY);
    const distinctId = raw
      ? (JSON.parse(raw) as { distinct_id?: unknown })?.distinct_id
      : null;
    return typeof distinctId === "string" && distinctId ? distinctId : null;
  } catch {
    // Storage may be unavailable; the guest bootstrap remains usable.
    return null;
  }
}

/**
 * The distinct id posthog-js will start with: its persisted one, else the
 * guest id it is bootstrapped with (see `getPostHogBootstrap`).
 */
export function getBootstrapDistinctId(): string | null {
  if (typeof window === "undefined") return null;
  return (
    readPersistedPostHogDistinctId() ?? getCachedGuestSession()?.guestId ?? null
  );
}

/**
 * Flag values for posthog-js's init-time bootstrap, or `null` for none (no
 * identity yet, a failure, a timeout, or an empty answer).
 */
export async function loadBootstrapFeatureFlags(): Promise<ClientFeatureFlagValues | null> {
  try {
    const distinctId = getBootstrapDistinctId();
    if (!distinctId) return null;
    // A guest is evaluated through its own token; without a bearer the
    // server answers only for an anonymous PostHog id.
    const guest = getCachedGuestSession();
    const flags = await fetchServerFeatureFlags({
      distinctId,
      bearer: guest?.guestId === distinctId ? guest.token : null,
      timeoutMs: BOOTSTRAP_FLAGS_TIMEOUT_MS,
    });
    return flags && Object.keys(flags).length > 0 ? flags : null;
  } catch {
    // The first render awaits this; it must never reject.
    return null;
  }
}

let refreshGeneration = 0;

/**
 * Re-evaluate the flags for the actor PostHog now identifies and replace the
 * SDK's values. A signed-in actor is evaluated through its access token (no
 * token, no refresh); a guest through its guest token when this tab holds it.
 * A newer refresh supersedes one still in flight.
 */
export async function refreshServerFeatureFlagsForActor(
  posthog: {
    updateFlags?: (flags: Record<string, boolean | string>) => void;
  },
  actor: {
    actorKey: string;
    isAuthedActor: boolean;
    getAccessToken?: () => Promise<string | null | undefined>;
  },
): Promise<void> {
  const generation = ++refreshGeneration;
  let flags: ClientFeatureFlagValues | null = null;
  try {
    let bearer: string | null = null;
    if (actor.isAuthedActor) {
      bearer = actor.getAccessToken
        ? ((await actor.getAccessToken().catch(() => null)) ?? null)
        : null;
      if (!bearer) return;
    } else {
      const guest = getCachedGuestSession();
      bearer = guest?.guestId === actor.actorKey ? guest.token : null;
    }
    flags = await fetchServerFeatureFlags({
      distinctId: actor.actorKey,
      bearer,
    });
  } catch {
    // A failed evaluation cannot preserve the previous actor's access flags.
  } finally {
    if (generation === refreshGeneration) posthog.updateFlags?.(flags ?? {});
  }
}
