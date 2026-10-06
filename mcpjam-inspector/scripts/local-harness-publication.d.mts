/** Types for the automated, resumable pack publication's decision logic. */
export declare const EQUIVALENCE_DIR: string;
export declare const EQUIVALENCE_SCHEMA: "mcpjam.local-harness-pack-equivalence/1";

export declare function compareVersions(a: string, b: string): number;
/** The next patch past every version named; "1.0.0" when none is. */
export declare function nextPatchVersion(versions: readonly string[]): string;
/** A release tag's pack version for this harness, or null for another's. */
export declare function versionFromTag(harnessId: string, tag: string): string | null;

export interface PinnedPack {
  version: string;
  digests: Record<string, string>;
  fingerprint: string | null;
}
export interface DescribedRelease {
  tag: string;
  version: string;
  draft: boolean;
  fingerprint: string | null;
  complete: boolean;
}
export interface EquivalenceRecord {
  file?: string;
  schema?: string;
  harnessId?: string;
  fingerprint: string;
  packVersion: string;
  digests: Record<string, string>;
}
export type PublicationAction = "up-to-date" | "adopt" | "finish-draft" | "build";
export declare function decidePublication(state: {
  fingerprint: string;
  pinned: PinnedPack | null;
  equivalences: readonly EquivalenceRecord[];
  releases: readonly DescribedRelease[];
}): { action: PublicationAction; version: string; reason: string };
export declare function decideAfterBuild(input: {
  built: Record<string, string>;
  pinned: { version: string; digests: Record<string, string> } | null;
}): { action: "equivalent"; version: string } | { action: "publish" };
export declare function classifyExisting(input: {
  fingerprint: string;
  release: Pick<DescribedRelease, "draft" | "fingerprint" | "complete"> | null;
}): "none" | "published" | "draft" | "conflict";
export declare function readEquivalenceRecords(
  harnessId: string,
  dir?: string,
): Array<EquivalenceRecord & { file: string }>;
export declare function equivalenceFileName(harnessId: string, fingerprint: string): string;
export declare function packSigningPublicKeys(): string[];

export declare const PACK_SIGNER_WORKFLOW: string;
export declare const EQUIVALENCE_SIGNER_WORKFLOW: string;
export declare function attestationVerifyArgs(path: string, options: { repo: string; workflow: string }): string[];
export declare function verifyAttestation(path: string, options: { repo: string; workflow: string }): Promise<string | null>;

export declare function missingEvidence(input: {
  harnessId: string;
  targets: readonly string[];
  digests: Record<string, string>;
  records: readonly any[];
  commit: string | null;
}): string[];

export declare const PIPELINE_STAGES: ReadonlyArray<{ job: string; stage: string; meaning: string }>;
export declare function pipelineOutcome(
  needs: Record<string, { result?: string }> | null | undefined,
): { status: "failed"; stage: string; meaning: string } | { status: "cancelled" } | { status: "succeeded" };
export declare function failureIssueTitle(harnessId: string): string;
export declare function resumeCommand(harnessId: string): string;
export declare function failureIssueBody(input: {
  harnessId: string;
  stage: string;
  meaning: string;
  runUrl: string;
  commit: string | null;
}): string;
export declare const PIN_INTENT_SCHEMA: "mcpjam.local-harness-pin-intent/1";
export interface PinIntent {
  schema: typeof PIN_INTENT_SCHEMA;
  harness: string;
  kind: "pin" | "equivalence" | "up-to-date";
  run?: string;
  previous?: string | null;
  version?: string;
  digests?: Record<string, string>;
  fingerprint?: string;
  conformance?: string;
  permitPrevious?: boolean;
  permitReason?: string;
  record?: string;
  sha256?: string;
}
export declare function checkPinIntent(intent: unknown): PinIntent;
export declare function checkPinIntents(intents: readonly unknown[], harnessIds: readonly string[]): PinIntent[];
export declare function pinSummary(intents: readonly PinIntent[]): string;
