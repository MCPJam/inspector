/**
 * Recovery for Claude web and ChatGPT web runs. A browser that crashed, slept
 * or lost its stream is reconnected and the account is left alone; only a
 * sign-in page the page module confirmed starts account recovery. That tries
 * the connection's sign-in method first. When the vendor needs a person, the
 * run waits on the account's one reconnect request, and the backend sends its
 * owner the one link. What a resume needs is in the backend, not in this
 * process.
 */
import { logger } from "../../../utils/logger.js";
import {
  identityOf,
  sameWebIdentity,
  WebBackendRefusal,
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
  /** The browser's profile archive, to save. Never logged. */
  captureProfile(): Promise<Uint8Array>;
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

export type WebRecoveryDeps = {
  backend: WebReconnectBackend;
  ledger: LedgerReader;
  /** Starts a paused run at its pending step; returns once it is under way. */
  resumeRun(runId: string, pendingStep: PendingStep): Promise<void>;
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
   * before the account was signed in again reloads the new profile instead.
   */
  restoredProfileVersion?: number;
};

export type NeedsSignInOutcome =
  /** Signed in again since this run's restore: reconnect on the saved profile. */
  | { status: "reload_profile" }
  /** The sign-in method signed in here: reconcile, then carry on. */
  | { status: "signed_in" }
  /** A person is needed. Stop this execution; `resumeRun` carries it on. */
  | { status: "paused"; requestId: string };

export type ResumedRun = ClaimedRun & { status: "resumed" | "failed" };

export type HandbackOutcome =
  | { status: "not_found" | "not_signed_in" | "cancelled" }
  /** Another seat is signed in: nothing saved, the account still needs sign-in. */
  | { status: "wrong_identity"; expected?: WebIdentity; observed?: WebIdentity }
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

/** The backend's refusals a handback answers with an outcome. */
const HANDBACK_REFUSALS: Partial<
  Record<string, "not_found" | "not_signed_in" | "wrong_identity">
> = {
  NOT_FOUND: "not_found",
  WEB_ACCOUNT_NEEDS_SIGN_IN: "not_signed_in",
  // An open request it found is refused only for another seat's email.
  CONFLICT: "wrong_identity",
};

type VerifiedSession =
  | { status: "saved"; identity: WebIdentity }
  | { status: "not_signed_in" }
  | { status: "wrong_identity"; expected?: WebIdentity; observed: WebIdentity };

export function createWebRecoveryCoordinator(
  deps: WebRecoveryDeps,
): WebRecoveryCoordinator {
  const { backend } = deps;
  const signInMethodFor = deps.signInMethodFor ?? (() => NO_SIGN_IN_METHOD);
  /** One sign-in attempt per account at a time in this process. */
  const attempts = new Map<string, Promise<boolean>>();

  async function findAccount(projectId: string, webAccountId: string) {
    const accounts = await backend.listWebAccounts({ projectId });
    const account = accounts.find((one) => one.webAccountId === webAccountId);
    if (!account) throw new WebBackendRefusal("NOT_FOUND");
    return account;
  }

  async function resumeWaiting(webAccountId: string): Promise<ResumedRun[]> {
    const claimed = await backend.claimResumableWebRuns({ webAccountId });
    const started = await Promise.allSettled(
      // Async, so a resumeRun that throws before it returns a promise fails
      // only its own run: the backend has already claimed all of them.
      claimed.map(async (run) => deps.resumeRun(run.runId, run.pendingStep)),
    );
    return claimed.map((run, index): ResumedRun => {
      const result = started[index];
      if (result.status === "fulfilled") return { ...run, status: "resumed" };
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

  /** Check the browser shows the account's own seat, then save its profile. */
  async function saveVerifiedSession(
    account: WebAccountRecord,
    browser: AccountBrowser,
    savedFromRunId?: string,
  ): Promise<VerifiedSession> {
    const observed = await browser.verifyAccount();
    if (!observed) return { status: "not_signed_in" };
    const expected = identityOf(account);
    // Another seat's session saved here would run the project's account as someone else.
    if (!expected || !sameWebIdentity(expected, observed)) {
      return { status: "wrong_identity", expected, observed };
    }
    const saved = await backend.saveWebAccountProfile({
      webAccountId: account.webAccountId,
      expectedProfileVersion: account.profileVersion,
      profile: await browser.captureProfile(),
      ...(savedFromRunId ? { savedFromRunId } : {}),
    });
    if (!saved.ok) {
      // Only verified sign-ins save, so the newer profile is this seat's too.
      logger.info("[web-recovery] Kept a newer saved profile", {
        webAccountId: account.webAccountId,
      });
    }
    return { status: "saved", identity: observed };
  }

  async function attemptSignIn(
    method: SignInMethod,
    report: AccountFailureReport & { reason: SignInReason },
    account: WebAccountRecord,
  ): Promise<boolean> {
    const { projectId, webAccountId, reason, browser, runId } = report;
    try {
      const context = { projectId, webAccountId, reason, browser };
      if ((await method.signIn(context)) !== "signed_in") return false;
      const session = await saveVerifiedSession(account, browser, runId);
      if (session.status === "saved") return true;
      logger.warn("[web-recovery] The sign-in method's session was refused", {
        method: method.id,
        outcome: session.status,
      });
    } catch (error) {
      logger.error("[web-recovery] The sign-in method failed", error, {
        method: method.id,
      });
    }
    return false;
  }

  /** Whether this run, another run's browser, or no one signed in. */
  async function signInWithoutPerson(
    report: AccountFailureReport & { reason: SignInReason },
    account: WebAccountRecord,
  ): Promise<"here" | "elsewhere" | "needs_person"> {
    const { webAccountId } = account;
    const method = signInMethodFor({
      projectId: report.projectId,
      webAccountId,
    });
    if (method.id === NO_SIGN_IN_METHOD.id) return "needs_person";
    const running = attempts.get(webAccountId);
    if (running) return (await running) ? "elsewhere" : "needs_person";
    const attempt = attemptSignIn(method, report, account).finally(() =>
      attempts.delete(webAccountId),
    );
    attempts.set(webAccountId, attempt);
    return (await attempt) ? "here" : "needs_person";
  }

  async function reportNeedsSignIn(
    report: AccountFailureReport & { reason: SignInReason },
  ): Promise<NeedsSignInOutcome> {
    const { projectId, webAccountId, runId, iterationId, reason } = report;
    const account = await findAccount(projectId, webAccountId);
    if (
      account.status === "ready" &&
      report.restoredProfileVersion !== undefined &&
      account.profileVersion > report.restoredProfileVersion
    ) {
      return { status: "reload_profile" };
    }
    // The method goes first, since reporting sends the owner a link. Once a
    // person has been asked, another attempt would only repeat their prompt.
    if (account.status !== "needs_sign_in" && reason !== "human_check") {
      const signedIn = await signInWithoutPerson(report, account);
      if (signedIn === "here") return { status: "signed_in" };
      if (signedIn === "elsewhere") return { status: "reload_profile" };
    }
    const { requestId } = await backend.reportWebSignInRequired({
      webAccountId,
      runId,
      ...(iterationId ? { iterationId } : {}),
      pendingStep: report.pendingStep,
      reason,
    });
    return { status: "paused", requestId };
  }

  async function handback(input: {
    projectId: string;
    requestId: string;
    browser: AccountBrowser;
  }): Promise<HandbackOutcome> {
    const { projectId, requestId } = input;
    const requests = await backend.listWebReconnectRequests({ projectId });
    const request = requests.find((one) => one.requestId === requestId);
    if (!request) return { status: "not_found" };
    if (request.status === "cancelled") return { status: "cancelled" };
    if (request.status === "open") {
      const account = await findAccount(projectId, request.webAccountId);
      const session = await saveVerifiedSession(account, input.browser);
      if (session.status === "wrong_identity") {
        logger.warn("[web-recovery] Handback refused for another seat", {
          requestId,
        });
        // Checking this browser can outlast a valid handback of the same
        // request, and the account that one made ready stays ready.
        const still = (
          await backend.listWebReconnectRequests({ projectId })
        ).find((one) => one.requestId === requestId);
        if (still?.status === "open") {
          await backend.markWebAccountNeedsSignIn({
            webAccountId: account.webAccountId,
            reason: "wrong_account",
          });
        }
      }
      if (session.status !== "saved") return session;
      const { accountEmail, workspaceName } = session.identity;
      // The backend marks the account ready and its waiting runs resumable.
      await backend.handbackWebReconnect({
        requestId,
        verifiedAccountEmail: accountEmail,
        ...(workspaceName ? { verifiedWorkspace: workspaceName } : {}),
      });
    }
    // A repeated handback, or one retried after a restart, finds the request
    // resolved and resumes only what still waits.
    return {
      status: "resumed",
      runs: await resumeWaiting(request.webAccountId),
    };
  }

  return {
    async handleStepFailure({ failure, ...report }) {
      if (failure.kind !== "needs_sign_in") {
        return { status: "reconnect_browser" };
      }
      return reportNeedsSignIn({ ...report, reason: failure.reason });
    },
    reportNeedsSignIn,
    async handback(input) {
      try {
        return await handback(input);
      } catch (error) {
        const status =
          error instanceof WebBackendRefusal
            ? HANDBACK_REFUSALS[error.code]
            : undefined;
        if (!status) throw error;
        return { status };
      }
    },
    resumeWaiting,
    reconcileBeforeResend: (input) => reconcileWithLedger(deps.ledger, input),
  };
}
