/**
 * The one place a surface asks "what may this turn's browser type?".
 *
 * ## Why it is not `runtimeSecrets`
 *
 * Materialized secrets already reach a turn on one path: `runtimeSecrets` →
 * `secretEnv` → the sandbox's environment, where a harness or a `bash` command
 * can read them. Exactly two surfaces wire that today, and the repo has
 * deliberately NOT wired it on the rest — `resolve-turn-runtime.ts` says so in
 * as many words, because starting to deliver project secrets into the eval and
 * swarm runners' boxes is a security-relevant change with its own review.
 *
 * This is a DIFFERENT delivery with a different blast radius, and keeping the
 * two apart is the point of the module. Nothing here reaches a box's
 * environment, a shell, or a harness. A value fetched here travels beside ONE
 * browser command, is substituted inside the daemon at the last moment, and is
 * scrubbed back out of everything the page returns. It is never an environment
 * variable, never in a tool-call argument, and never in the transcript.
 *
 * So a surface can offer `{{secret:NAME}}` in the browser without taking on the
 * question the other path is still waiting on.
 *
 * ## Fail-closed, and free while the flag is off
 *
 * The flag is checked FIRST, before any credential is asked for: with it off
 * this costs nothing at all — no Convex round trip, no KMS decrypt — which is
 * what makes it safe to call from an eval runner that does this per iteration.
 *
 * And unlike the harness fetch, a FAILURE here is not a tri-state. There, "no
 * secrets" and "could not find out" have different consequences, so collapsing
 * them strips a working session's credentials. Here both end the same way: no
 * placeholder resolves, the model is told `secret_unknown`, and nothing is
 * typed into the page. An empty list IS the safe answer.
 */
import { browserSecretPlaceholdersEnabled } from "../../config.js";
import { fetchRuntimeSecrets } from "../harness/runtime-secrets.js";

/** What a browser may substitute, by name. Never logged, never persisted. */
export type BrowserSecret = { name: string; value: string };

export async function resolveBrowserSecrets(args: {
  bearer?: string;
  projectId?: string;
  /** The GRANT BOUNDARY. No environment means no grant, so no secrets. */
  environmentId?: string;
  chatSessionId?: string;
  /**
   * A list this turn ALREADY resolved, used instead of fetching.
   *
   * ONE READ PER TURN is the rule the harness path states for itself, and for
   * the same reason: two reads are two decrypts, and a window in which the two
   * answers disagree.
   */
  resolved?: readonly BrowserSecret[];
  env?: NodeJS.ProcessEnv;
}): Promise<readonly BrowserSecret[]> {
  if (!browserSecretPlaceholdersEnabled(args.env ?? process.env)) return [];
  if (args.resolved !== undefined) return args.resolved;
  const fetched = await fetchRuntimeSecrets(args.bearer, {
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.environmentId ? { environmentId: args.environmentId } : {}),
    ...(args.chatSessionId ? { chatSessionId: args.chatSessionId } : {}),
  });
  return fetched.ok ? fetched.secrets : [];
}
