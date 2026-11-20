import { webPost } from "@/lib/apis/web/base";

/*
 * The Inspector server's web account routes: the hosted browser an admin
 * signs in with, saving that sign-in for the project, and handing a signed
 * in account back to the runs waiting on it.
 */

export type SaveProfileResult =
  | { ok: true; accountEmail: string; workspaceName?: string }
  | {
      ok: false;
      reason: "not_signed_in" | "wrong_account" | "version_conflict";
    };

export type HandbackResult =
  | { status: "resumed"; resumedRuns: number }
  | { status: "not_signed_in" | "wrong_identity" | "not_found" | "cancelled" };

const accountPath = (webAccountId: string) =>
  `/api/web-clients/accounts/${encodeURIComponent(webAccountId)}`;

/** The hosted browser a sign-in started. */
export interface WebAccountSignInStarted {
  /** The browser the route keeps for this sign-in; save-profile names it. */
  browserSessionId: string;
  /** The chat the browser belongs to; the pane's browser token names it. */
  chatSessionId?: string;
}

/** Starts a hosted browser on the vendor's sign-in page, for this account. */
export function startWebAccountSignIn(projectId: string, webAccountId: string) {
  return webPost<{ projectId: string }, WebAccountSignInStarted>(
    `${accountPath(webAccountId)}/sign-in`,
    { projectId },
  );
}

/** Saves the signed-in browser as the account's profile. */
export function saveWebAccountProfile(
  projectId: string,
  webAccountId: string,
  browserSessionId: string,
) {
  return webPost<
    { projectId: string; browserSessionId: string },
    SaveProfileResult
  >(`${accountPath(webAccountId)}/save-profile`, {
    projectId,
    browserSessionId,
  });
}

/**
 * Hands a signed-in account back, so the runs waiting on it resume. The
 * server reads the sign-in browser `browserSessionId` names.
 */
export function handBackWebReconnect(
  projectId: string,
  requestId: string,
  browserSessionId: string,
) {
  return webPost<
    { projectId: string; browserSessionId: string },
    HandbackResult
  >(`/api/web-clients/reconnect/${encodeURIComponent(requestId)}/handback`, {
    projectId,
    browserSessionId,
  });
}
