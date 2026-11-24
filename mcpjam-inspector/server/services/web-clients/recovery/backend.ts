/**
 * The durable side of web account recovery: each account's verified identity
 * and saved profile, at most one open reconnect request per account, and the
 * runs waiting on it. It lives in the backend so that a restarted process, or
 * another replica, resumes from what was recorded rather than from memory.
 */
import type {
  WebAccountStatus,
  WebClientVendor,
} from "../../../../shared/web-clients.js";

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
  /**
   * When the step first started, as `toISOString()` writes it. Calls
   * forwarded earlier are not this step's. The ledger here and the backend's
   * `findWebToolCalls` both parse it and compare it as a time. One that
   * doesn't parse bounds nothing here but matches no call there.
   */
  startedAt: string;
  /** The turn the step opened on its connector, once it got that far. */
  turnId?: string;
};

export type WebIdentity = { accountEmail: string; workspaceName?: string };

/** The fields recovery reads from the backend's view of a web account. */
export type WebAccountRecord = {
  webAccountId: string;
  projectId: string;
  vendor?: WebClientVendor;
  status: WebAccountStatus;
  accountEmail?: string;
  workspaceName?: string;
  /** Compare-and-set token for the saved browser profile. */
  profileVersion: number;
};

/** A reconnect request, as the backend lists it. Times are epoch ms. */
export type WebReconnectRequest = {
  requestId: string;
  webAccountId: string;
  status: "open" | "resolved" | "cancelled";
  reason: string;
  openedAt: number;
  notifiedAt?: number;
  notificationCount: number;
  resolvedAt?: number;
  waitingRunCount: number;
};

export type ClaimedRun = {
  requestId: string;
  runId: string;
  iterationId?: string;
  pendingStep: PendingStep;
};

export type SaveProfileResult =
  | { ok: true; profileVersion: number }
  /** Another verified sign-in saved first. Its profile stays. */
  | { ok: false; reason: "version_conflict"; profileVersion: number };

/** A refusal with the backend's code, such as `NOT_FOUND` or `CONFLICT`. */
export class WebBackendRefusal extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WebBackendRefusal";
  }
}

/**
 * The backend functions recovery calls, under the names the backend exports.
 * Refusals throw a `WebBackendRefusal`.
 */
export interface WebReconnectBackend {
  listWebAccounts(args: { projectId: string }): Promise<WebAccountRecord[]>;
  markWebAccountNeedsSignIn(args: {
    webAccountId: string;
    reason: SignInReason;
  }): Promise<void>;
  /**
   * Compare-and-set on `profileVersion`. `profile` is the browser's profile
   * archive; only its ciphertext leaves this server. A run saving back names
   * itself in `savedFromRunId`; without one, only an admin may save.
   */
  saveWebAccountProfile(args: {
    webAccountId: string;
    expectedProfileVersion: number;
    profile: Uint8Array;
    savedFromRunId?: string;
  }): Promise<SaveProfileResult>;
  /**
   * Marks the account Needs sign-in and adds the run to its open request,
   * opening one when there is none. The report that opens it gets
   * `shouldNotify: true`, and the backend sends that request's one notice. A
   * run that reports again keeps its first place and step.
   *
   * When the account is ready on a newer profile than the one the run
   * restored, it was signed in again after the run read it: the report
   * changes nothing and answers `reloadProfile`. The backend compares in the
   * same mutation that writes, so a handback that lands first wins.
   */
  reportWebSignInRequired(args: {
    webAccountId: string;
    runId: string;
    iterationId?: string;
    pendingStep: PendingStep;
    reason: SignInReason;
    restoredProfileVersion?: number;
  }): Promise<
    { requestId: string; shouldNotify: boolean } | { reloadProfile: true }
  >;
  /**
   * Marks the account ready and the request's runs resumable. Idempotent.
   * Refuses another seat or a cancelled request (`CONFLICT`).
   */
  handbackWebReconnect(args: {
    requestId: string;
    verifiedAccountEmail: string;
    verifiedWorkspace?: string;
  }): Promise<{ resumableRunIds: string[] }>;
  /** Atomic: each resumable run is returned once, ever. */
  claimResumableWebRuns(args: { webAccountId: string }): Promise<ClaimedRun[]>;
  /** Recent requests of every status, so a repeated handback finds its own. */
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
