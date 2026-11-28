/**
 * Types for the Cursor CLI pack recipe. The recipe is plain ESM run by a bare
 * Node in CI, so it carries a hand-written declaration.
 */
export declare const harnessId: "cursor";
export declare const recipeSources: readonly string[];
export declare const dependencyRoots: readonly string[];
/** No install files: Cursor's package is downloaded, not installed from a lockfile. */
export declare function loadRecipe(): Promise<{
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
}>;
/** Nothing to install: there is no package graph. */
export declare function stageRecipe(
  packRoot: string,
  installDependencies?: () => void | Promise<void>,
): Promise<{ bridgeDigest?: string }>;
/** Download the target's archive, check its size and SHA-256, extract it into
 *  `node_modules/@anysphere/agent-cli-runtime/`, and check it holds Cursor's
 *  own Node and `index.js`. */
export declare function verifyVendorBinary(
  packRoot: string,
  platformKey: string,
): { path: string; sha256: string; bytes: number };
/** Refuse anything in the pack but Cursor's package. */
export declare function prunePack(packRoot: string, platformKey?: string): void;
export declare function vendorPackages(packRoot: string): Record<string, string>;
export declare function adapterVersion(): string;
