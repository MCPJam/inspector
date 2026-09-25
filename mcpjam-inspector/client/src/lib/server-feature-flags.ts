import {
  pickClientFeatureFlags,
  type ClientFeatureFlagValues,
} from "../../../shared/client-feature-flags";
import { getCachedGuestSession } from "./guest-session";
import { detectPlatform, VITE_PUBLIC_POSTHOG_KEY } from "./PosthogUtils";

/**
 * PostHog flag values come from our own server (`GET /api/web/flags`), which
 * evaluates the allowlist in shared/client-feature-flags.ts. posthog-js is
 * bootstrapped with them at init and runs with remote flag loading off
 * (`getPostHogOptions`), then gets a fresh set whenever the PostHog identity
 * changes (`refreshServerFeatureFlagsForActor`). (MJ-015)
 *
 * Every failure here degrades to "no new values": posthog-js keeps the flags
 * it already has, and nothing on this path can fail the app's boot.
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
    if (!response.ok) return null;
    const body = (await response.json()) as { flags?: unknown } | null;
    return pickClientFeatureFlags(body?.flags);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// posthog-js persists its identity under `ph_<token>_posthog` (localStorage,
// mirrored to a cookie). localStorage wins when both are present, as it does
// inside posthog-js.
function readPersistedPostHogDistinctId(): string | null {
  const storageKey = `ph_${VITE_PUBLIC_POSTHOG_KEY}_posthog`;
  const candidates: Array<() => string | null | undefined> = [
    () => window.localStorage?.getItem(storageKey),
    () => {
      const prefix = `${storageKey}=`;
      const entry = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix));
      return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
    },
  ];
  for (const read of candidates) {
    try {
      const raw = read();
      if (!raw) continue;
      const distinctId = (JSON.parse(raw) as { distinct_id?: unknown })
        ?.distinct_id;
      if (typeof distinctId === "string" && distinctId) return distinctId;
    } catch {
      // Unreadable storage or entry: try the next one.
    }
  }
  return null;
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
    const flags = await fetchServerFeatureFlags({
      distinctId,
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
    const flags = await fetchServerFeatureFlags({
      distinctId: actor.actorKey,
      bearer,
    });
    if (generation !== refreshGeneration) return;
    if (!flags || Object.keys(flags).length === 0) return;
    posthog.updateFlags?.(flags);
  } catch {
    // Flags stay as they are; nothing on this path may break the caller.
  }
}
