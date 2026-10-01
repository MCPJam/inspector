/**
 * Types for the pack build script's exported build and digest helpers.
 *
 * The script itself is plain ESM — it runs under a bare Node in CI without a
 * compilation step — so it carries a hand-written declaration. Per-harness
 * recipe staging lives in `local-harness-pack-recipes/<harnessId>.mjs`; the
 * digest helpers here stay independent of any recipe. The full build runs
 * only at the process entry.
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

/** Arguments that list an archive; GNU tar needs `--force-local` on Windows paths. */
export declare function archiveListArgs(
  tar: { bin: string; gnu: boolean },
  archivePath: string,
): string[];
