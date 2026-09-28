/**
 * Resolves the secrets a turn's browser may type.
 *
 * Deliberately separate from `runtimeSecrets` (sandbox env delivery): these
 * values travel beside one browser command, are substituted in the daemon, and
 * are scrubbed from page output. They never become env vars, tool-call
 * arguments or transcript text.
 *
 * The flag is checked before any fetch, so this is free when off. Any failure
 * returns an empty list, which fails closed: no placeholder resolves and
 * nothing is typed.
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
  /** Already resolved this turn; reused so a turn reads secrets once. */
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
