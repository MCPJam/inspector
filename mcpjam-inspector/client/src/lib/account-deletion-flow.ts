import { create } from "zustand";
import {
  AccountDeletionClient,
  AccountDeletionError,
} from "@mcpjam/sdk/account-deletion";
import { authFetch } from "@/lib/session-token";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { disconnectAllRuntimeServers } from "@/state/mcp-api";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import {
  markSignOutInProgress,
  clearOwnedSignOut,
  ownsSignOut,
  renewOwnedSignOut,
  isSignOutInProgress,
  SIGN_OUT_REQUEST_TIMEOUT_MS,
} from "@/lib/auth/sign-out-latch";
import { pauseQueriesBeforeAuthClear } from "@/lib/auth/pause-queries-before-auth-clear";
import {
  prepareAccountDeletion,
  claimAccountDeletion,
  discardAccountDeletion,
  activateAccountDeletion,
} from "./account-deletion-storage";

export const accountDeletionClient = () =>
  new AccountDeletionClient({
    baseUrl: "/api/web/account-deletion",
    authenticatedFetch: authFetch,
  });
export const accountReceiptPath = (localId: string) =>
  `/account-deletion/receipt/${encodeURIComponent(localId)}`;
export const useAccountDeletionFlow = create<{ error: string; busy: boolean }>(
  () => ({ error: "", busy: false }),
);
type SignOut = (options: {
  returnTo: string;
  navigate: false;
}) => void | Promise<void>;

async function bounded(
  work: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function releaseExit(attempt: ExitAttempt): void {
  if (
    attempt.owner !== undefined &&
    clearOwnedSignOut(attempt.owner) &&
    !attempt.priorPaused &&
    useSessionRefreshStore.getState().authEpoch === attempt.priorEpoch
  ) {
    useSessionRefreshStore.getState().resumeQueries();
  }
}
function exitStillOwned(
  attempt: ExitAttempt,
  allowMissingActor = false,
): boolean {
  if (attempt.owner === undefined || !ownsSignOut(attempt.owner)) return false;
  const actor = attempt.currentActorSubject();
  if (actor === attempt.actorSubject) return true;
  // Server revocation can clear the original identity. It permits receipt navigation only.
  if (actor === undefined) return allowMissingActor;
  releaseExit(attempt);
  useAccountDeletionFlow.setState({
    error:
      "Your account changed. The deletion recovery record has been kept in this browser.",
  });
  return false;
}
async function finishExit(
  attempt: ExitAttempt,
  signOut: SignOut,
): Promise<void> {
  if (!attempt.pendingId || !exitStillOwned(attempt, true)) return;
  const localId = attempt.pendingId;
  const inspection = useWebmcpInspectorStore.getState();
  const cleanup: Promise<unknown>[] = [
    Promise.resolve().then(() => {
      if (exitStillOwned(attempt)) return disconnectAllRuntimeServers();
    }),
  ];
  if (inspection.session && !inspection.session.sessionId.startsWith("hosted:"))
    cleanup.push(
      Promise.resolve().then(() => {
        if (exitStillOwned(attempt)) return inspection.closeSession();
      }),
    );
  await bounded(Promise.allSettled(cleanup), SIGN_OUT_REQUEST_TIMEOUT_MS);
  if (!exitStillOwned(attempt, true)) return;
  const returnTo = new URL(accountReceiptPath(localId), window.location.origin)
    .href;
  // Logout may fail after local session revocation. Recovery still works without that session.
  await bounded(
    Promise.resolve()
      .then(() => {
        if (exitStillOwned(attempt))
          return signOut({ returnTo, navigate: false });
      })
      .catch(() =>
        useAccountDeletionFlow.setState({
          error:
            "Sign-out could not be confirmed. Check your deletion receipt.",
        }),
      ),
    SIGN_OUT_REQUEST_TIMEOUT_MS,
  );
  if (exitStillOwned(attempt, true)) window.location.assign(returnTo);
}
function refusal(error: unknown): string {
  if (error instanceof AccountDeletionError) {
    if (error.code === "ACCOUNT_OWNERSHIP_CHANGED")
      return "Organization ownership changed. Check the requirements and try again.";
    if (error.code === "ACCOUNT_DELETION_UNAVAILABLE")
      return "Account deletion is unavailable. Try again later.";
    if (error.code === "ACCOUNT_IDENTITY_COVERAGE_REQUIRED")
      return "Your account identities need verification. Contact support before deleting your account.";
  }
  return "Account deletion was not accepted. Check the requirements and try again.";
}

type ExitAttempt = {
  actorSubject: string;
  currentActorSubject: () => string | undefined;
  owner?: number;
  pendingId?: string;
  claimed: boolean;
  intakeStarted: boolean;
  recoverOnly: boolean;
  priorPaused: boolean;
  priorEpoch: number;
};
function mustRecover(error: unknown, attempt: ExitAttempt): boolean {
  if (attempt.recoverOnly) return true;
  if (!attempt.intakeStarted) return false;
  if (!(error instanceof AccountDeletionError)) return true;
  return (
    (error.status === 0 || error.status >= 500) &&
    error.code !== "ACCOUNT_DELETION_UNAVAILABLE"
  );
}
async function rejectAttempt(
  error: unknown,
  attempt: ExitAttempt,
): Promise<void> {
  releaseExit(attempt);
  let message =
    error instanceof AccountDeletionError
      ? refusal(error)
      : "Receipt recovery could not be saved. Allow browser storage and try again.";
  if (attempt.pendingId && attempt.claimed) {
    try {
      await discardAccountDeletion(attempt.pendingId);
    } catch {
      message =
        "The recovery record could not be cleared. Keep it and contact support before trying again.";
    }
  }
  useAccountDeletionFlow.setState({ error: message });
}
async function recoverAttempt(
  attempt: ExitAttempt,
  signOut: SignOut,
): Promise<void> {
  if (attempt.owner === undefined || !attempt.pendingId) return;
  try {
    await finishExit(attempt, signOut);
  } catch {
    useAccountDeletionFlow.setState({
      error:
        "Keep your recovery record and refresh this page to check your deletion receipt.",
    });
  }
}

/** Only a first claimed attempt can submit. Saved attempts always recover without new intake. */
export async function startAccountDeletion(
  actorSubject: string,
  checkpoint: string,
  signOut: SignOut,
  currentActorSubject: () => string | undefined,
): Promise<void> {
  if (useAccountDeletionFlow.getState().busy || isSignOutInProgress()) return;
  useAccountDeletionFlow.setState({ busy: true, error: "" });
  const prior = useSessionRefreshStore.getState();
  const attempt: ExitAttempt = {
    actorSubject,
    currentActorSubject,
    claimed: false,
    intakeStarted: false,
    recoverOnly: false,
    priorPaused: prior.queriesPaused,
    priorEpoch: prior.authEpoch,
  };
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    const pending = await prepareAccountDeletion(actorSubject);
    attempt.pendingId = pending.localId;
    attempt.claimed = await claimAccountDeletion(pending.localId);
    if (
      pending.actorSubject !== actorSubject ||
      currentActorSubject() !== actorSubject ||
      isSignOutInProgress() ||
      useSessionRefreshStore.getState().authEpoch !== attempt.priorEpoch
    ) {
      throw new AccountDeletionError(409, "ACCOUNT_DELETION_SESSION_CHANGED");
    }
    activateAccountDeletion(pending.localId);
    attempt.owner = markSignOutInProgress();
    const owner = attempt.owner;
    renewal = setInterval(() => renewOwnedSignOut(owner), 2_000);
    pauseQueriesBeforeAuthClear();
    attempt.recoverOnly = !attempt.claimed;
    if (attempt.claimed) {
      attempt.intakeStarted = true;
      await accountDeletionClient().request({
        receiptSecret: pending.receiptSecret,
        idempotencyKey: pending.idempotencyKey,
        ownershipCheckpointSha256: checkpoint,
      });
      attempt.recoverOnly = true;
    }
    await recoverAttempt(attempt, signOut);
  } catch (error) {
    if (mustRecover(error, attempt)) await recoverAttempt(attempt, signOut);
    else await rejectAttempt(error, attempt);
  } finally {
    clearInterval(renewal);
    useAccountDeletionFlow.setState({ busy: false });
  }
}
