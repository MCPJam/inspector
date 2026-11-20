/**
 * The durable side of web account recovery: each account's verified identity
 * and saved profile, at most one open reconnect request per account, and the
 * runs waiting on it. It lives in the backend so that a restarted process, or
 * another replica, resumes from what was recorded rather than from memory.
 */
import type { WebAccountStatus } from "../../../../shared/web-clients.js";

/** What the vendor's page asked for when it stopped the run. */
export type SignInReason =
  | "signed_out"
  | "password"
  | "mfa"
  | "consent"
  | "human_check"
  | "wrong_account";

/** Where a paused run picks up again. The backend stores it as given. */
export type PendingStep = {
  /** The runtime's own name for the step, such as the prompt's index. */
  stepId: string;
  /** When the step first started (ISO). Calls forwarded earlier are not its own. */
  startedAt: string;
  /** The turn the step opened on its connector, once it got that far. */
  turnId?: string;
};

export type WebIdentity = { accountEmail: string; workspaceName?: string };

export type WebAccountRecord = {
  webAccountId: string;
  projectId: string;
  status: WebAccountStatus;
  accountEmail?: string;
  workspaceName?: string;
  /** Compare-and-set token for the saved browser profile. */
  profileVersion: number;
};

export type WaitingRun = {
  runId: string;
  iterationId?: string;
  pendingStep: PendingStep;
  /** Set when a coordinator claimed the run to resume it. */
  claimedAt?: string;
};

export type WebReconnectRequest = {
  requestId: string;
  projectId: string;
  webAccountId: string;
  reason: SignInReason;
  status: "open" | "handed_back";
  openedAt: string;
  notifiedAt?: string;
  runs: WaitingRun[];
};

export type ClaimedRun = {
  requestId: string;
  runId: string;
  iterationId?: string;
  pendingStep: PendingStep;
};

export type SaveProfileResult =
  | { status: "saved"; profileVersion: number }
  /** Another verified sign-in saved first. Its profile stays. */
  | { status: "conflict"; profileVersion: number };

export type HandbackResult = {
  status:
    "handed_back" | "already_handed_back" | "wrong_identity" | "not_found";
};

/** The backend functions recovery calls, under the names the backend exports. */
export interface WebReconnectBackend {
  listWebAccounts(args: { projectId: string }): Promise<WebAccountRecord[]>;
  markWebAccountVerified(
    args: { webAccountId: string } & WebIdentity,
  ): Promise<void>;
  markWebAccountNeedsSignIn(args: {
    webAccountId: string;
    reason: SignInReason;
  }): Promise<void>;
  /**
   * Compare-and-set on `profileVersion`. `profile` is the runtime's serialized
   * browser profile; the backend encrypts it before storing it.
   */
  saveWebAccountProfile(args: {
    webAccountId: string;
    expectedProfileVersion: number;
    profile: string;
  }): Promise<SaveProfileResult>;
  /**
   * Adds the run to the account's open request, opening one when there is
   * none. `shouldNotify` is true exactly once per request: for the report that
   * opened it. A run that reports again keeps one place, at its latest step.
   */
  reportWebSignInRequired(args: {
    webAccountId: string;
    runId: string;
    iterationId?: string;
    pendingStep: PendingStep;
    reason: SignInReason;
  }): Promise<{ requestId: string; shouldNotify: boolean }>;
  markWebReconnectNotified(args: { requestId: string }): Promise<void>;
  /** Idempotent. Refuses an identity that is not the account's. */
  handbackWebReconnect(args: {
    requestId: string;
    verifiedAccountEmail: string;
    verifiedWorkspace?: string;
  }): Promise<HandbackResult>;
  /** Atomic: each run waiting on a handed-back request is returned once, ever. */
  claimResumableWebRuns(args: { webAccountId: string }): Promise<ClaimedRun[]>;
  /** Open and handed-back requests, so a repeated handback still finds its own. */
  listWebReconnectRequests(args: {
    projectId: string;
  }): Promise<WebReconnectRequest[]>;
}

/**
 * Same person and workspace. Emails compare without case. A workspace counts
 * only when the account recorded one, since personal accounts have none.
 */
export function sameWebIdentity(
  expected: WebIdentity,
  observed: WebIdentity,
): boolean {
  const normal = (value?: string) => value?.trim().toLowerCase();
  if (normal(expected.accountEmail) !== normal(observed.accountEmail)) {
    return false;
  }
  return (
    expected.workspaceName === undefined ||
    normal(expected.workspaceName) === normal(observed.workspaceName)
  );
}

export function identityOf(
  account: Pick<WebAccountRecord, "accountEmail" | "workspaceName">,
): WebIdentity | undefined {
  if (!account.accountEmail) return undefined;
  return {
    accountEmail: account.accountEmail,
    ...(account.workspaceName ? { workspaceName: account.workspaceName } : {}),
  };
}
