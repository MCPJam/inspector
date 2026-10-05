/** Types for the shared pack harness registry and naming rules. */
export declare const PACK_RECIPES_DIR: string;
export declare function packReleaseTag(harnessId: string, packVersion: string): string;
export declare function packAssetStem(
  harnessId: string,
  target: string,
  packVersion: string,
): string;
export declare function packReleaseBaseUrl(harnessId: string, packVersion: string): string;
export declare function listPackHarnessIds(recipesDir?: string): string[];
export declare function packRecipeModulePath(harnessId: string): string;
export interface PackHarnessRecipe {
  harnessId: string;
  recipeSources: readonly string[];
  dependencyRoots: readonly string[];
  loadRecipe(): Promise<{ bootstrapDir: string; files: Array<{ path: string; content: string }> }>;
  /** True for a recipe whose bridge still ships in its pack; the build then
   *  copies the loopback launcher in beside it. */
  packLauncher?: boolean;
  stageRecipe(packRoot: string, install: () => void | Promise<void>): Promise<{ bridgeDigest?: string }>;
  verifyVendorBinary(packRoot: string, platformKey: string): { path: string; sha256: string; bytes: number };
  prunePack(packRoot: string, platformKey?: string): void;
  vendorPackages(packRoot: string): Record<string, string>;
  adapterVersion(): string;
}
export declare function loadPackHarness(
  harnessId: string,
  recipesDir?: string,
): Promise<PackHarnessRecipe>;
