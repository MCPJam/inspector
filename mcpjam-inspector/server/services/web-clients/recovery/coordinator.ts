/**
 * Recovery for Claude web and ChatGPT web runs. A browser that crashed, slept
 * or lost its stream is reconnected and the account is left alone; only a
 * sign-in page the page module confirmed starts account recovery. That tries
 * the connection's sign-in method first, and when the vendor needs a person
 * the run waits on the account's one reconnect request, whose owner gets one
 * link. What a resume needs is in the backend, not in this process.
 */
import { logger } from "../../../utils/logger.js";
import {
  identityOf,
  sameWebIdentity,
  type ClaimedRun,
  type PendingStep,
  type SignInReason,
  type WebAccountRecord,
  type WebIdentity,
  type WebReconnectBackend,
} from "./backend.js";
import {
  reconcileWithLedger,
  type LedgerReader,
  type ReconcileInput,
  type ReconcileOutcome,
} from "./reconcile.js";

/**
 * Why a step failed. `needs_sign_in` is the page module's confirmed outcome
 * (sign-in page, password or code prompt, consent screen, human check); a
 * sign-in URL glimpsed while the browser was failing is a browser failure
 * until the reconnected page confirms it.
 */
export type RunFailure =
  | {
      kind:
        | "browser_crashed"
        | "browser_asleep"
        | "stream_dropped"
        | "network_error"
        | "page_timeout";
    }
  | { kind: "needs_sign_in"; reason: SignInReason };

export function classifyRunFailure(failure: RunFailure): "browser" | "account" {
  return failure.kind === "needs_sign_in" ? "account" : "browser";
}

/** The runtime's handle on a browser at the vendor's site. */
export type AccountBrowser = {
  /** Who the vendor's page shows as signed in, or undefined for no one. */
  verifyAccount(): Promise<WebIdentity | undefined>;
  /** The serialized profile for `saveWebAccountProfile`. Never logged. */
  captureProfile(): Promise<string>;
};

/**
 * How a connection signs in again without a person, such as with a project
 * test inbox or a vault-held authenticator. It is never called for a human
 * check (B1): those always go to a person.
 */
export interface SignInMethod {
  readonly id: string;
  signIn(context: {
    projectId: string;
    webAccountId: string;
    reason: SignInReason;
    browser: AccountBrowser;
  }): Promise<"signed_in" | "needs_person">;
}

/** The default: no automatic sign-in, so a person signs in. */
export const NO_SIGN_IN_METHOD: SignInMethod = {
  id: "none",
  signIn: async () => "needs_person",
};

export type ReconnectNotice = {
  requestId: string;
  projectId: string;
  webAccountId: string;
  reason: SignInReason;
};

export type WebRecoveryDeps = {
  backend: WebReconnectBackend;
  ledger: LedgerReader;
  /** Starts a paused run at its pending step; returns once it is under way. */
  resumeRun(runId: string, pendingStep: PendingStep): Promise<void>;
  /** Sends the reconnect owner the private link for a request. */
  notify(notice: ReconnectNotice): Promise<void>;
  /** The sign-in method the connection authorized; `none` when omitted. */
  signInMethodFor?(account: {
    projectId: string;
    webAccountId: string;
  }): SignInMethod;
};

export type AccountFailureReport = {
  projectId: string;
  webAccountId: string;
  runId: string;
  iterationId?: string;
  pendingStep: PendingStep;
  /** The run's own browser, where a sign-in method signs in. */
  browser: AccountBrowser;
  /**
   * The profile version the run's browser restored, so a run that started
   * before a handback reloads the new profile instead of opening a request.
   */
  restoredProfileVersion?: number;
};

export type NeedsSignInOutcome =
  /** Signed in again since this run's restore: reconnect on the saved profile. */
  | { status: "reload_profile" }
  /** The sign-in method signed in: reconcile, then carry on with the step. */
  | { status: "signed_in" }
  /** Stop this execution: the run waits for a person, or already resumed elsewhere. */
  | { status: "paused"; requestId: string; notified: boolean };

export type ResumedRun = ClaimedRun & {
  /** `continues_here`: the reporting run is still running, so not restarted. */
  status: "resumed" | "continues_here" | "failed";
};

export type HandbackOutcome =
  | { status: "not_found" | "not_signed_in" }
  /** Another seat is signed in: nothing saved, the account still needs sign-in. */
  | { status: "wrong_identity"; expected?: WebIdentity; observed: WebIdentity }
  | { status: "resumed"; runs: ResumedRun[] };

export interface WebRecoveryCoordinator {
  /** Every failed step comes here, so a browser failure never reaches the account. */
  handleStepFailure(
    report: AccountFailureReport & { failure: RunFailure },
  ): Promise<{ status: "reconnect_browser" } | NeedsSignInOutcome>;
  reportNeedsSignIn(
    report: AccountFailureReport & { reason: SignInReason },
  ): Promise<NeedsSignInOutcome>;
  /** A person signed in, in `browser`, for the request their link names. */
  handback(input: {
    projectId: string;
    requestId: string;
    browser: AccountBrowser;
  }): Promise<HandbackOutcome>;
  /** Resumes each run whose request was handed back and not yet resumed. */
  resumeWaiting(webAccountId: string): Promise<ResumedRun[]>;
  reconcileBeforeResend(input: ReconcileInput): Promise<ReconcileOutcome>;
}

export function createWebRecoveryCoordinator(
  deps: WebRecoveryDeps,
): WebRecoveryCoordinator {
  const { backend } = deps;
  const signInMethodFor = deps.signInMethodFor ?? (() => NO_SIGN_IN_METHOD);

  async function findAccount(projectId: string, webAccountId: string) {
    const accounts = await backend.listWebAccounts({ projectId });
    const account = accounts.find((one) => one.webAccountId === webAccountId);
    if (!account) throw new Error(`Web account ${webAccountId} was not found.`);
    return account;
  }

  async function resumeWaiting(webAccountId: string, continuingRunId?: string) {
    const claimed = await backend.claimResumableWebRuns({ webAccountId });
    const started = await Promise.allSettled(
      claimed.map(async (run) => {
        if (run.runId !== continuingRunId) {
          await deps.resumeRun(run.runId, run.pendingStep);
        }
      }),
    );
    return claimed.map((run, index): ResumedRun => {
      const result = started[index];
      if (result.status === "fulfilled") {
        const here = run.runId === continuingRunId;
        return { ...run, status: here ? "continues_here" : "resumed" };
      }
      // A claimed run is never handed out again, so a person must send it again.
      logger.error(
        "[web-recovery] A claimed run did not resume",
        result.reason,
        {
          runId: run.runId,
        },
      );
      return { ...run, status: "failed" };
    });
  }

  /** Verify the seat, save its profile, clear Needs sign-in, hand back, resume. */
  async function completeSignIn(
    requestId: string,
    account: WebAccountRecord,
    browser: AccountBrowser,
    continuingRunId?: string,
  ): Promise<HandbackOutcome> {
    const { webAccountId } = account;
    const observed = await browser.verifyAccount();
    if (!observed) return { status: "not_signed_in" };
    const expected = identityOf(account);
    const refused = { status: "wrong_identity", expected, observed } as const;
    // Another seat's session saved here would run the project's account as someone else.
    if (!expected || !sameWebIdentity(expected, observed)) return refused;
    const saved = await backend.saveWebAccountProfile({
      webAccountId,
      expectedProfileVersion: account.profileVersion,
      profile: await browser.captureProfile(),
    });
    if (saved.status === "conflict") {
      // Only verified sign-ins save, so the newer profile is this seat's too.
      logger.info("[web-recovery] Kept a newer saved profile", {
        webAccountId,
      });
    }
    const { accountEmail, workspaceName } = observed;
    await backend.markWebAccountVerified({
      webAccountId,
      accountEmail,
      ...(workspaceName ? { workspaceName } : {}),
    });
    const handedBack = await backend.handbackWebReconnect({
      requestId,
      verifiedAccountEmail: accountEmail,
      ...(workspaceName ? { verifiedWorkspace: workspaceName } : {}),
    });
    if (handedBack.status === "not_found") return { status: "not_found" };
    if (handedBack.status === "wrong_identity") return refused;
    const runs = await resumeWaiting(webAccountId, continuingRunId);
    return { status: "resumed", runs };
  }

  /** The connection's own sign-in, and whether this run carries on here. */
  async function signInWithoutPerson(
    report: AccountFailureReport & { reason: SignInReason },
    requestId: string,
  ): Promise<"continues_here" | "resumed_elsewhere" | "needs_person"> {
    const { projectId, webAccountId, reason, browser, runId } = report;
    const method = signInMethodFor({ projectId, webAccountId });
    if (reason === "human_check" || method.id === NO_SIGN_IN_METHOD.id) {
      return "needs_person";
    }
    try {
      const context = { projectId, webAccountId, reason, browser };
      if ((await method.signIn(context)) !== "signed_in") return "needs_person";
      const account = await findAccount(projectId, webAccountId);
      const outcome = await completeSignIn(requestId, account, browser, runId);
      if (outcome.status === "resumed") {
        // A person's handback during the attempt may have claimed this run
        // first. Then it resumes there, and this execution must stop.
        const here = outcome.runs.some(
          (run) => run.runId === runId && run.status === "continues_here",
        );
        return here ? "continues_here" : "resumed_elsewhere";
      }
      logger.warn("[web-recovery] The sign-in method's session was refused", {
        method: method.id,
        outcome: outcome.status,
      });
    } catch (error) {
      logger.error("[web-recovery] The sign-in method failed", error, {
        method: method.id,
      });
    }
    return "needs_person";
  }

  async function sendLink(notice: ReconnectNotice): Promise<boolean> {
    const { requestId } = notice;
    try {
      await deps.notify(notice);
    } catch (error) {
      // The request stays open without `notifiedAt`; the pause panel offers its link.
      logger.error("[web-recovery] The reconnect link was not sent", error, {
        requestId,
      });
      return false;
    }
    await backend
      .markWebReconnectNotified({ requestId })
      .catch((error: unknown) =>
        logger.warn("[web-recovery] A sent reconnect link was not recorded", {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  async function reportNeedsSignIn(
    report: AccountFailureReport & { reason: SignInReason },
  ): Promise<NeedsSignInOutcome> {
    const { projectId, webAccountId, runId, iterationId, reason } = report;
    if (report.restoredProfileVersion !== undefined) {
      const account = await findAccount(projectId, webAccountId);
      if (
        account.status === "ready" &&
        account.profileVersion > report.restoredProfileVersion
      ) {
        return { status: "reload_profile" };
      }
    }
    const { requestId, shouldNotify } = await backend.reportWebSignInRequired({
      webAccountId,
      runId,
      ...(iterationId ? { iterationId } : {}),
      pendingStep: report.pendingStep,
      reason,
    });
    // Only the report that opened the request acts on it, so another run or a
    // repeated report never signs in again or sends a second link.
    if (!shouldNotify) return { status: "paused", requestId, notified: false };
    const attempt = await signInWithoutPerson(report, requestId);
    if (attempt === "continues_here") return { status: "signed_in" };
    if (attempt === "resumed_elsewhere") {
      return { status: "paused", requestId, notified: false };
    }
    await backend.markWebAccountNeedsSignIn({ webAccountId, reason });
    const notice = { requestId, projectId, webAccountId, reason };
    return { status: "paused", requestId, notified: await sendLink(notice) };
  }

  return {
    async handleStepFailure({ failure, ...report }) {
      if (failure.kind !== "needs_sign_in") {
        return { status: "reconnect_browser" };
      }
      return reportNeedsSignIn({ ...report, reason: failure.reason });
    },
    reportNeedsSignIn,
    async handback({ projectId, requestId, browser }) {
      const requests = await backend.listWebReconnectRequests({ projectId });
      const request = requests.find((one) => one.requestId === requestId);
      if (!request) return { status: "not_found" };
      // A repeated handback, or one retried after a restart, resumes what still waits.
      if (request.status === "handed_back") {
        const runs = await resumeWaiting(request.webAccountId);
        return { status: "resumed", runs };
      }
      const account = await findAccount(projectId, request.webAccountId);
      const outcome = await completeSignIn(requestId, account, browser);
      if (outcome.status === "wrong_identity") {
        logger.warn("[web-recovery] Handback refused for another seat", {
          requestId,
        });
        await backend.markWebAccountNeedsSignIn({
          webAccountId: account.webAccountId,
          reason: "wrong_account",
        });
      }
      return outcome;
    },
    resumeWaiting: (webAccountId) => resumeWaiting(webAccountId),
    reconcileBeforeResend: (input) => reconcileWithLedger(deps.ledger, input),
  };
}
