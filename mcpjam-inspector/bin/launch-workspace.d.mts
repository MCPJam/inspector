/**
 * Types for the launcher's invocation-folder reader.
 *
 * `bin/` is plain ESM — it runs under a bare Node before anything is built —
 * so this carries a hand-written declaration rather than being compiled. The
 * server test suite imports the module to prove the folder an `npx` user
 * launched from is what gets suggested, and that the package/cache directory
 * never is.
 */
export declare function launchWorkspaceCandidate(args: {
  /** The installed package root, which is never a valid suggestion. */
  projectRoot: string;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}): string | null;
