/**
 * The accounts an eval run connected with: `PlatformEvalRun.accounts`.
 * Recorded when the run started, so a later rename or token upload does not
 * change what an earlier run reports.
 */

/**
 * Whose an account's token was when the run started: from the server's
 * profile tool (`profile`) or from the token's own claims (`token`), which
 * nothing verified.
 */
export interface PlatformEvalRunAccountIdentity {
  source: "profile" | "token";
  /** The profile's name or nickname, or the token's `preferred_username`. */
  name?: string;
  /** The profile's id, or the token's `sub`. */
  subject?: string;
  /** The token's `iss`. */
  issuer?: string;
  /**
   * Present only when you may see it: a project account's email for every
   * project member, a personal account's only for the person who started the
   * run (for an API launch, the key's owner).
   */
  email?: string;
  /** Where `email` came from, which can differ from `source`. */
  emailSource?: "profile" | "token";
}

/** One account a run used on one server. */
export interface PlatformEvalRunAccount {
  cases?: Array<{
    testCaseId: string;
    source: "case" | "run" | "suite" | "default";
  }>;
  /** The saved server, as `listProjectServers` returns it. */
  serverId: string;
  /** The account's id in the server accounts API. Absent for a project server's default account and for XAA. */
  accountId?: string;
  /** The account's name when the run started. Never an email. */
  name: string;
  /** `personal`, a project server's `project` account, or an `xaa` identity. */
  kind: "personal" | "project" | "xaa";
  /** Present and true for a readiness reviewer login, whose email every project member sees. */
  reviewer?: boolean;
  /** Present and true when the token was uploaded through the accounts API rather than signed in. */
  tokenUploaded?: boolean;
  /** Who stored the token, by the name teammates see. */
  tokenStoredBy?: string;
  /** When the token was stored, epoch ms. */
  tokenStoredAt?: number;
  /** When the token expired or expires, epoch ms. */
  tokenExpiresAt?: number;
  identity?: PlatformEvalRunAccountIdentity;
}
