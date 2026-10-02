/**
 * Types for the pack build script's exported build and digest helpers.
 *
 * The script itself is plain ESM — it runs under a bare Node in CI without a
 * compilation step — so it carries a hand-written declaration. Recipe staging
 * loads the shared TypeScript bootstrap leaf through tsx; digest helpers stay
 * independent of that import. The full build runs only at the process entry.
 */
export declare function computeTreeDigest(root: string): {
  digest: string;
  files: number;
  bytes: number;
};

/**
 * Give every file under `root` its own inode, returning how many paths had to
 * be copied. See the script for why the archive depends on it.
 */
export declare function flattenHardLinks(root: string): number;

/** Install the patched recipe, adding the runtime .npmrc only after install. */
export declare function installClaudeCodePackRecipe(
  packRoot: string,
  installDependencies: () => void | Promise<void>,
): Promise<{ bridgeDigest: string }>;
