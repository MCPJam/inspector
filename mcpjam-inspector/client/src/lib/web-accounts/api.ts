import { makeFunctionReference } from "convex/server";
import type { WebAccountStatus, WebClientVendor } from "@/shared/web-clients";

/*
 * Every backend function the app calls for web accounts, kept in one module
 * so the client and the backend meet in a single place: accounts in
 * `convex/webClients.ts`, a suite's choices in `convex/webClientSuites.ts`,
 * and runs waiting on a sign-in in `convex/webClientReconnect.ts`.
 */

/**
 * A project's web account, as the backend's `toWebAccountView` returns it.
 * Its status values are the UI's `WebAccountStatus`, one for one.
 */
export interface WebAccount {
  webAccountId: string;
  projectId: string;
  vendor: WebClientVendor;
  label: string;
  status: WebAccountStatus;
  /** Why the account needs sign-in, as the run that found it said. */
  statusReason?: string;
  /** The account's address on the vendor's site, once a sign-in was verified. */
  accountEmail?: string;
  workspaceName?: string;
  hasProfile: boolean;
  profileVersion: number;
  profileSavedAt?: number;
  profileSizeBytes?: number;
  /** Who is asked to sign in again when a run finds the account signed out. */
  reconnectOwnerUserId: string;
  /** Members' local apps may use this account. */
  allowLocalRuns: boolean;
  createdAt: number;
  lastVerifiedAt?: number;
  isDefault: boolean;
}

/** One person's choice of web accounts for a suite, per vendor. */
export interface SuiteWebAccountChoice {
  vendor: WebClientVendor;
  webAccountIds: string[];
}

/** Runs waiting for an admin to sign a web account in again. */
export interface WebReconnectRequest {
  requestId: string;
  webAccountId: string;
  status: "open" | "resolved" | "cancelled";
  /** What the run saw, in the runtime's words. */
  reason: string;
  openedAt: number;
  resolvedAt?: number;
  waitingRunCount: number;
}

type Account = { webAccountId: string };

export const webAccountsApi = {
  list: makeFunctionReference<"query", { projectId: string }, WebAccount[]>(
    "webClients:listWebAccounts",
  ),
  create: makeFunctionReference<
    "mutation",
    { projectId: string; vendor: WebClientVendor; label: string },
    { webAccountId: string; account: WebAccount }
  >("webClients:createWebAccount"),
  rename: makeFunctionReference<
    "mutation",
    Account & { label: string },
    WebAccount
  >("webClients:renameWebAccount"),
  setDefault: makeFunctionReference<"mutation", Account, WebAccount>(
    "webClients:setDefaultWebAccount",
  ),
  remove: makeFunctionReference<"mutation", Account, { removed: true }>(
    "webClients:removeWebAccount",
  ),
  setAllowLocalRuns: makeFunctionReference<
    "mutation",
    Account & { allowLocalRuns: boolean },
    WebAccount
  >("webClients:setWebAccountAllowLocalRuns"),
  mySuiteChoices: makeFunctionReference<
    "query",
    { suiteId: string },
    SuiteWebAccountChoice[]
  >("webClientSuites:getMySuiteWebAccountChoices"),
  setSuiteSelection: makeFunctionReference<
    "mutation",
    { suiteId: string; vendor: WebClientVendor; webAccountIds: string[] },
    SuiteWebAccountChoice
  >("webClientSuites:setSuiteWebAccountSelection"),
  reconnectRequests: makeFunctionReference<
    "query",
    { projectId: string },
    WebReconnectRequest[]
  >("webClientReconnect:listWebReconnectRequests"),
};
