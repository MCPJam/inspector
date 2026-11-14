/**
 * Types for the GitHub Copilot CLI pack recipe. The recipe is plain ESM run by
 * a bare Node in CI, so it carries a hand-written declaration.
 */
export declare const harnessId: "copilot-cli";
export declare const recipeSources: readonly string[];
export declare const dependencyRoots: readonly string[];
/** The bridge package's manifest, lockfile and workspace file the vendor graph is installed from. */
export declare function loadRecipe(): Promise<{
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
}>;
/** Install the frozen vendor graph, then drop the install files, `ws` and the FFI host's `koffi`. */
export declare function stageRecipe(
  packRoot: string,
  installDependencies: () => void | Promise<void>,
): Promise<{ bridgeDigest?: string }>;
/** Check the pinned versions, then every file of the target's platform build against the recorded checksums. */
export declare function verifyVendorBinary(
  packRoot: string,
  platformKey: string,
): { path: string; sha256: string; bytes: number };
/** Drop other platforms' builds, then refuse anything but the CLI, its SDK and their JavaScript dependencies. */
export declare function prunePack(packRoot: string, platformKey?: string): void;
export declare function vendorPackages(packRoot: string): Record<string, string>;
export declare function adapterVersion(): string;
