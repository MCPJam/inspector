import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { getCachedGuestSession } from "@/lib/guest-session";

/**
 * How often the bearer is re-read. WorkOS access tokens live for minutes and
 * `getAccessToken` refreshes them ahead of expiry; a token that lapses
 * between reads only makes the relay treat that request conservatively.
 */
export const RELAY_AUTH_REFRESH_MS = 60_000;

/**
 * Authenticate PostHog's requests to the relay with the current actor's
 * bearer, through posthog-js `request_headers` — never in a URL. The relay
 * uses it to check each event's capture context against the backend, then
 * strips it before forwarding to PostHog. A request without it (no session,
 * a token not read yet, an unload beacon) is handled conservatively there.
 *
 * Existing tokens only: the signed-in user's WorkOS token, or the guest
 * session already in memory. This never mints a guest just for telemetry.
 * The header is cleared the moment the actor changes, before the next
 * actor's token is read, and a read that finishes after a later change is
 * dropped.
 */
export function usePostHogRelayAuth({
  actorKey,
  signedIn,
  getAccessToken,
}: {
  actorKey: string | null;
  signedIn: boolean;
  getAccessToken: () => Promise<string | null | undefined>;
}): void {
  const posthog = usePostHog();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  useEffect(() => {
    if (!posthog?.set_config) return;
    let cancelled = false;
    const setBearer = (token: string | null) => {
      try {
        posthog.set_config({
          request_headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      } catch {
        // Telemetry must not interrupt the app.
      }
    };
    const refresh = async () => {
      let token: string | null = null;
      try {
        token = signedIn
          ? ((await getAccessTokenRef.current()) ?? null)
          : (getCachedGuestSession()?.token ?? null);
      } catch {
        token = null;
      }
      if (!cancelled) setBearer(token);
    };
    setBearer(null);
    if (actorKey) {
      void refresh();
    }
    const timer = actorKey
      ? setInterval(() => void refresh(), RELAY_AUTH_REFRESH_MS)
      : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [posthog, actorKey, signedIn]);
}
