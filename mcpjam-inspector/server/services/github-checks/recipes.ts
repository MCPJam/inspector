/**
 * Run recipes: the OPERATOR OVERRIDE table (rung 0 of the resolution ladder).
 *
 * This started life as the ONE hardcoded piece of the GitHub-checks walking
 * skeleton — the unsolved problem in "test an arbitrary MCP server's PR" is not
 * the testing but knowing how to build and start the server, so the plumbing was
 * built first against a single controlled fixture repo. The resolution ladder
 * (declared config → detection → agentic fallback) has since landed, and this
 * table is no longer how any repo is expected to resolve. It is an operator
 * ESCAPE HATCH, and it is deliberately EMPTY.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ WHAT AN ENTRY HERE COSTS — read before adding one.                      │
 * │                                                                         │
 * │ The override rung sits ABOVE the declared rung (resolver/index.ts): an  │
 * │ override outranks a repo's own `mcpjam.yaml` even when both exist. So   │
 * │ an entry here MASKS that repository's declared config for as long as it │
 * │ is present, and every check on that repo resolves through this table    │
 * │ instead of through the ladder.                                          │
 * │                                                                         │
 * │ That is exactly how the fixture entry that used to live here made the   │
 * │ ladder untestable: deleting the fixture's yaml, breaking it, or         │
 * │ exercising detection all produced the same override recipe and the same │
 * │ green check. A smoke test that goes green while testing nothing.        │
 * │                                                                         │
 * │ Add an entry only to unblock a repo the ladder genuinely cannot resolve │
 * │ (and prefer fixing the ladder), remove it as soon as it is unblocked,   │
 * │ and update the guard test that asserts this table is empty — the guard  │
 * │ exists so the cost is acknowledged rather than discovered later.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A repo with no recipe at all resolves to `recipe_unresolvable` (a NEUTRAL
 * check — "we couldn't figure this out", never a failure attributed to the PR).
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
  /**
   * Non-secret configuration literals, injected into the BUILD and the START
   * commands and nowhere else (`sandbox.ts` passes them as E2B's `envs` command
   * option, never as shell text).
   *
   * ONLY AN AUTHORITATIVE RUNG PRODUCES THIS. Today that means a repository's
   * committed `mcpjam.yaml` (`resolver/mcpjamYaml.ts`), which is the only real
   * producer, plus the operator override table above; the backend REJECTS an
   * `env` on a cacheable `detected` or `agentic` recipe, so detection must never
   * invent one and a cached recipe is always env-free.
   *
   * NEVER PUT A CREDENTIAL HERE. The values are committed to a repository and
   * persisted verbatim in the backend's durable plan rows — nothing redacts
   * them and nothing expires them. The clone token is the counter-example of how
   * a secret IS handled: minted per check, carried on one command, redacted out
   * of every observable failure, and never an environment variable.
   *
   * Absent means absent: an empty map is normalized away at the parser, so
   * `undefined` is the only shape "no environment" ever takes.
   */
  env?: Record<string, string>;
};

/**
 * Keyed by lowercased `owner/repo`, matching the backend's allowlist
 * normalization (GitHub repo names are case-insensitive).
 */
export type RecipeTable = Readonly<Record<string, CheckRecipe>>;

/**
 * The PRODUCTION override table. Empty on purpose — see the module docblock for
 * what an entry costs. `mcpjam/mcp-check-fixture` used to live here; it now
 * carries its own `mcpjam.yaml` and resolves at rung 1 like any other repo,
 * which is the only way the ladder is actually exercised end to end.
 */
export const RECIPES_TABLE: RecipeTable = {};

/**
 * The lookup itself, over an EXPLICIT table.
 *
 * Separated from the production table so the lookup's behaviour — the trim, the
 * case fold, the null for anything absent — is testable as a FUNCTION rather
 * than as a property of whatever happens to be configured. The old tests read
 * `RECIPES[0]` to get a repo to look up, which meant emptying the table (the
 * correct change) broke tests that were never about the table's contents.
 */
export function lookupRecipe(
  table: RecipeTable,
  repoFullName: string
): CheckRecipe | null {
  if (typeof repoFullName !== "string") return null;
  return table[repoFullName.trim().toLowerCase()] ?? null;
}

export function resolveCheckRecipe(repoFullName: string): CheckRecipe | null {
  return lookupRecipe(RECIPES_TABLE, repoFullName);
}

/** Exposed for tests and for an operator sanity-checking a deployment. */
export function listRecipeRepos(): string[] {
  return Object.keys(RECIPES_TABLE);
}
