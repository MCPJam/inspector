/** Types for the revocation list maintenance script. */
export interface RevokedPackEntry {
  harnessId: string;
  treeDigest: string;
  reason: string;
}
export interface RevocationListDocument {
  schema: "mcpjam.local-harness-revocations/1";
  sequence: number;
  issuedAt: string;
  revoked: RevokedPackEntry[];
}
export declare const REVOCATIONS_FILE: string;
export declare const REVOCATION_SCHEMA: "mcpjam.local-harness-revocations/1";
export declare function revocationListProblems(list: unknown): string[];
export declare function addRevocation(
  list: RevocationListDocument,
  entry: RevokedPackEntry,
  now?: Date,
): RevocationListDocument;
export declare function renderRevocationList(list: RevocationListDocument): string;
