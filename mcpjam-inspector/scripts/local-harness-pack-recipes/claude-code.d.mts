/**
 * Types for the Claude Code pack recipe. The recipe is plain ESM run by a bare
 * Node in CI, so it carries a hand-written declaration.
 */
export declare const harnessId: "claude-code";
export declare const recipeSources: readonly string[];
export declare const dependencyRoots: readonly string[];
/** The agent SDK version `claude-code-vendor/package.json` pins. */
export declare function vendorSdkVersion(): string;
/** The vendor manifest and lockfile the pack is installed from. */
export declare function loadRecipe(): Promise<{
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
}>;
/** Install the frozen vendor graph, then drop the install manifests. */
export declare function stageRecipe(
  packRoot: string,
  installDependencies: () => void | Promise<void>,
): Promise<{ bridgeDigest?: string }>;
export declare function verifyVendorBinary(
  packRoot: string,
  platformKey: string,
): { path: string; sha256: string; bytes: number };
export declare function prunePack(packRoot: string, platformKey?: string): void;
export declare function vendorPackages(packRoot: string): Record<string, string>;
export declare function adapterVersion(): string;
