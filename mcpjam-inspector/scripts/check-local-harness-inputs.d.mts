/** Types for the per-harness pack input fingerprint. */
import type { PackHarnessRecipe } from "./local-harness-pack-harnesses.mjs";

export declare const SHARED_PACK_INPUTS: readonly string[];
export interface PackInputIo {
  readFile(path: string): Promise<Buffer | string>;
  readdir(path: string): Promise<string[]>;
  readLockPackages(): Promise<Record<string, any>>;
  listHarnesses(): Promise<string[]>;
  loadHarness(
    harnessId: string,
  ): Promise<Pick<PackHarnessRecipe, "recipeSources" | "dependencyRoots" | "loadRecipe">>;
  /** What is installed at a lockfile key. Only `installedClosureDrift` uses it. */
  inspectInstalled?(
    key: string,
  ): Promise<
    | { kind: "absent" }
    | { kind: "linked"; target?: string }
    | { kind: "installed"; version: string }
  >;
}
export declare const defaultPackInputIo: PackInputIo;
export declare function packDependencyClosure(
  packages: Record<string, any>,
  roots?: readonly string[],
): Record<string, { version: string; integrity?: string; resolved?: string }>;
export declare function computeHarnessPackInputs(
  harnessId: string,
  io?: PackInputIo,
): Promise<{ fingerprint: string; inputs: Record<string, string> }>;
export declare function computePackInputs(io?: PackInputIo): Promise<{
  schema: 2;
  harnesses: Record<string, { fingerprint: string; inputs: Record<string, string> }>;
}>;
/** Why the installed tree cannot produce a trustworthy snapshot; [] when it can. */
export declare function installedClosureDrift(io?: PackInputIo): Promise<string[]>;
export declare function readRecordedPackInputs(
  harnessId: string,
): Promise<{ fingerprint: string; inputs: Record<string, string> } | null>;
