/**
 * The backend every inspector this suite boots talks to: MCPJam's community
 * deployment, the same one the tracked `.env.local` names. It runs backend
 * `main` and admits guests. It is never production.
 *
 * A packaged build reads `.env.production`, which names production. Booted
 * as-is, every run minted real guests through app.mcpjam.com and ran the pull
 * request's code against production functions, so a PR that called a function
 * production did not have yet failed there instead of here. These variables
 * win over that file (dotenv never overrides a variable that is already set),
 * and the server hands the Convex URL and WorkOS client to the page at
 * runtime, so the browser follows them without a rebuild.
 *
 * Guests are minted by the community deployment itself, which takes its
 * guest-session secret. The suite reads it from the environment and stops
 * before booting without it.
 */
export const COMMUNITY_BACKEND = {
  convexUrl: "https://energized-ant-201.convex.cloud",
  httpUrl: "https://energized-ant-201.convex.site",
  workosClientId: "client_01KTN2EWHHJCKRB8RSR307X4SG",
} as const;

/** Server environment for a locally booted inspector. */
export function communityBackendEnv(): Record<string, string> {
  if (!process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET?.trim()) {
    throw new Error(
      `The e2e suite boots the inspector against the community backend ` +
        `(${COMMUNITY_BACKEND.httpUrl}) and needs its guest-session secret in ` +
        `MCPJAM_GUEST_SESSION_SHARED_SECRET. To drive a deployed inspector ` +
        `instead, set PLAYWRIGHT_BASE_URL.`,
    );
  }
  return {
    CONVEX_URL: COMMUNITY_BACKEND.convexUrl,
    VITE_CONVEX_URL: COMMUNITY_BACKEND.convexUrl,
    CONVEX_HTTP_URL: COMMUNITY_BACKEND.httpUrl,
    WORKOS_CLIENT_ID: COMMUNITY_BACKEND.workosClientId,
    // Without this the server mints guests from app.mcpjam.com.
    MCPJAM_GUEST_AUTHORITY: "backend",
  };
}

/**
 * Chromium flag that makes production unresolvable, so a production URL
 * baked into the client bundle cannot reach it either. Covers MCPJam's own
 * hosts and every Convex deployment except the community one. Only for a
 * locally booted inspector: a run against a deployed URL
 * (`PLAYWRIGHT_BASE_URL`) needs those hosts.
 */
export const NO_PRODUCTION_BROWSER_ARGS = [
  "--host-resolver-rules=" +
    [
      "MAP mcpjam.com ~NOTFOUND",
      "MAP *.mcpjam.com ~NOTFOUND",
      "MAP *.convex.cloud ~NOTFOUND",
      "MAP *.convex.site ~NOTFOUND",
      `EXCLUDE ${new URL(COMMUNITY_BACKEND.convexUrl).hostname}`,
      `EXCLUDE ${new URL(COMMUNITY_BACKEND.httpUrl).hostname}`,
    ].join(", "),
];
