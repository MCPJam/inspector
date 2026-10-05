/**
 * Types for the Codex pack recipe. The recipe is plain ESM run by a bare Node
 * in CI, so it carries a hand-written declaration.
 */
export declare const harnessId: "codex";
export declare const recipeSources: readonly string[];
export declare const dependencyRoots: readonly string[];
/** Regenerates the bridge bundle, then returns the app-server bootstrap recipe. */
export declare function loadRecipe(): Promise<{
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
}>;
/** Stage the recipe and `bootstrap.json`, then install its frozen graph. */
export declare function stageRecipe(
  packRoot: string,
  installDependencies: () => void | Promise<void>,
): Promise<{ bridgeDigest: string }>;
/** Check every file of the target's platform package against the recorded checksums. */
export declare function verifyVendorBinary(
  packRoot: string,
  platformKey: string,
): { path: string; sha256: string; bytes: number };
/** Drop other platforms' packages, then refuse anything unexpected in `@openai`. */
export declare function prunePack(packRoot: string, platformKey?: string): void;
export declare function vendorPackages(packRoot: string): Record<string, string>;
export declare function adapterVersion(): string;
