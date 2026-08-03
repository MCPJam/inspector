/**
 * Run recipes: how to turn a PR checkout into a reachable MCP server.
 *
 * This is the ONE hardcoded piece of the GitHub-checks walking skeleton, and it
 * is hardcoded on purpose. The unsolved problem in "test an arbitrary MCP
 * server's PR" is not the testing — eval suites and the runner already exist —
 * it is knowing how to build and start the server. The eventual answer is a
 * resolution ladder (declared config → repo metadata → detection → agentic
 * fallback). Everything AROUND that ladder is production plumbing, so it is
 * built first against a single controlled fixture repo, and the ladder later
 * replaces `RECIPES` without touching anything else.
 *
 * A repo with no recipe resolves to `recipe_unresolvable` (a NEUTRAL check —
 * "we couldn't figure this out", never a failure attributed to the PR). In the
 * skeleton that state is unreachable through the webhook, since the repo
 * allowlist and this table are configured together; the worker still handles it
 * defensively, because the resolver era makes it routine.
 */

export type CheckRecipe = {
  /** Run to completion before the server starts. Non-zero exit = `build_failed`. */
  build: string;
  /** Long-running; spawned in the background and expected to bind `port`. */
  start: string;
  /**
   * The port the started server listens on INSIDE the sandbox. The bind
   * address does not matter: the E2B host bridge proxies from inside the box,
   * so loopback-bound servers are reachable too (e2e-verified 2026-08-02 —
   * scenario C bound `127.0.0.1` and passed). What DOES surface as
   * `server_unhealthy` is listening on a different port than declared here.
   */
  port: number;
  /** Path the streamable-HTTP MCP endpoint is served on. */
  mcpPath: string;
};

/**
 * Keyed by lowercased `owner/repo`, matching the backend's allowlist
 * normalization (GitHub repo names are case-insensitive).
 */
const RECIPES: Record<string, CheckRecipe> = {
  "mcpjam/mcp-check-fixture": {
    build: "npm ci && npm run build",
    start: "npm start",
    port: 3001,
    mcpPath: "/mcp",
  },
};

export function resolveCheckRecipe(repoFullName: string): CheckRecipe | null {
  if (typeof repoFullName !== "string") return null;
  return RECIPES[repoFullName.trim().toLowerCase()] ?? null;
}

/** Exposed for tests and for an operator sanity-checking a deployment. */
export function listRecipeRepos(): string[] {
  return Object.keys(RECIPES);
}
