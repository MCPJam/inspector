/**
 * Types for the pack build script's exported digest implementation.
 *
 * The script itself is plain ESM — it runs under a bare Node in CI, with no
 * TypeScript in the loop — so it carries a hand-written declaration rather than
 * being compiled. Only the digest function is exported; the build entry point
 * runs on `main()` when the script is the process entry.
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
