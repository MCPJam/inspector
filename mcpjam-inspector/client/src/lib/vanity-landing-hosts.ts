/**
 * The public vanity landings and what they are allowed to do without a
 * session.
 *
 * Mirrors the server-side landing-host defaults (CANIUSE_LANDING_HOSTS /
 * SCORE_LANDING_HOSTS in server/config.ts), including the split between them
 * — keep in sync when a vanity domain is added.
 */
export const CANIUSE_LANDING_HOSTS = new Set([
  "caniuse.dev",
  "www.caniuse.dev",
]);

export const SCORE_LANDING_HOSTS = new Set([
  "score.mcpjam.com",
  "www.score.mcpjam.com",
]);

/** Every vanity landing, which is what the landing-analytics rule keys on. */
export const VANITY_LANDING_HOSTS = new Set([
  ...CANIUSE_LANDING_HOSTS,
  ...SCORE_LANDING_HOSTS,
]);

/** The hosted app, linked to from the public compare table. */
export const MAIN_PRODUCT_URL = "https://app.mcpjam.com";

export function isVanityLandingHost(hostname: string): boolean {
  return VANITY_LANDING_HOSTS.has(hostname.toLowerCase());
}

export function isCaniuseLandingHost(hostname: string): boolean {
  return CANIUSE_LANDING_HOSTS.has(hostname.toLowerCase());
}

/**
 * Whether this page should boot WITHOUT minting a guest session.
 *
 * caniuse.dev serves one thing: the host-compare table, which reads the
 * PUBLIC `/api/v1/host-catalog` document (mounted ahead of auth in
 * server/routes/v1/index.ts). A guest session buys that page nothing, and
 * minting one spends from a per-IP daily budget of 20
 * (GUEST_SESSION_ISSUE_PER_IP_PER_DAY in the backend's
 * guestEndpointRateLimit). One office behind a NAT, or one person testing,
 * exhausts it and every later visitor from that network meets a sign-in
 * banner on a page that never needed an identity.
 *
 * Keyed on the HOST, not the path. Everything caniuse.dev is routed to serve
 * is that public document — its root redirects to the compare table and
 * `/capabilities/<slug>` is the same catalog — while the surfaces that do
 * need a guest (the score runner, the benchmark, shared results) live on
 * other domains. A path check would only restate `isBareCaniuseRoute`, which
 * covers score paths too and so is the wrong shape here.
 *
 * score.mcpjam.com is deliberately NOT included: its runner mints runs
 * against a guest identity.
 */
export function shouldSkipGuestSession(
  hostname: string | undefined = typeof window === "undefined"
    ? undefined
    : window.location.hostname,
): boolean {
  return Boolean(hostname) && isCaniuseLandingHost(hostname as string);
}
