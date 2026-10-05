/**
 * Types for the Claude Code pack recipe. The recipe is plain ESM run by a bare
 * Node in CI, so it carries a hand-written declaration.
 */
export declare const harnessId: "claude-code";
/** The bridge still ships in this pack, so the launcher is copied beside it. */
export declare const packLauncher: true;
export declare const recipeSources: readonly string[];
export declare const dependencyRoots: readonly string[];
export declare function loadRecipe(): Promise<{
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
}>;
/** Install the patched recipe, adding the runtime .npmrc only after install. */
export declare function stageRecipe(
  packRoot: string,
  installDependencies: () => void | Promise<void>,
): Promise<{ bridgeDigest: string }>;
export declare function verifyVendorBinary(
  packRoot: string,
  platformKey: string,
): { path: string; sha256: string; bytes: number };
export declare function prunePack(packRoot: string): void;
export declare function vendorPackages(packRoot: string): Record<string, string>;
export declare function adapterVersion(): string;
