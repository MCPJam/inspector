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
/** An IO that can say what is installed: what the drift check needs. */
export type PackInputIoWithInstalls = PackInputIo & {
  inspectInstalled: NonNullable<PackInputIo["inspectInstalled"]>;
};
/** Why the installed tree cannot produce a trustworthy snapshot; [] when it can. */
export declare const defaultPackInputIo: PackInputIoWithInstalls;
export declare function installedClosureDrift(io?: PackInputIoWithInstalls): Promise<string[]>;
export declare function readRecordedPackInputs(
  harnessId: string,
): Promise<{ fingerprint: string; inputs: Record<string, string> } | null>;
export interface MovedFingerprint {
  harnessId: string;
  recorded: string | null;
  computed: string | null;
}
/** Which recorded fingerprints differ from the computed ones; [] when none moved. */
export declare function movedFingerprints(
  recorded: { harnesses?: Record<string, { fingerprint: string }> } | null,
  computed: { harnesses: Record<string, { fingerprint: string }> },
): MovedFingerprint[];
/** The snapshot with one harness's record replaced and the others carried over. */
export declare function withHarnessRecord<T extends { fingerprint: string; inputs: Record<string, string> }>(
  recorded: { schema: number; harnesses: Record<string, T> } | null,
  computed: { schema: 2; harnesses: Record<string, T> },
  harnessId: string,
): { schema: 2; harnesses: Record<string, T> };
/** The job-summary text for moved fingerprints ("" when none moved). */
export declare function advisorySummary(moved: MovedFingerprint[]): string;
