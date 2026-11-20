import { makeFunctionReference } from "convex/server";
import type { WebAccountStatus, WebClientVendor } from "@/shared/web-clients";

/**
 * Every backend function the app calls for web accounts, kept in one module
 * so the client and `convex/webClients.ts` meet in a single place. Names and
 * shapes follow the HARN-129 contract. It names the suite selections only by
 * table and has no set-default, so those three names are this module's.
 */
/** A project's web account, as the account list shows it. */
export interface WebAccount {
  webAccountId: string;
  vendor: WebClientVendor;
  label?: string;
  /** The account's address on the vendor's site, once a sign-in was verified. */
  accountEmail?: string;
  workspaceName?: string;
  status: WebAccountStatus;
  isDefault: boolean;
  /** Members' local apps may use this account. */
  allowLocalRuns: boolean;
}

/** One person's choice of web accounts for a suite, per vendor. */
export interface SuiteWebAccountSelection {
  vendor: WebClientVendor;
  webAccountIds: string[];
}

type Account = { webAccountId: string };

export const webAccountsApi = {
  list: makeFunctionReference<"query", { projectId: string }, WebAccount[]>(
    "webClients:listWebAccounts",
  ),
  rename: makeFunctionReference<"mutation", Account & { label: string }, null>(
    "webClients:renameWebAccount",
  ),
  setDefault: makeFunctionReference<"mutation", Account, null>(
    "webClients:setDefaultWebAccount",
  ),
  remove: makeFunctionReference<"mutation", Account, null>(
    "webClients:removeWebAccount",
  ),
  setAllowLocalRuns: makeFunctionReference<
    "mutation",
    Account & { allowLocalRuns: boolean },
    null
  >("webClients:setWebAccountAllowLocalRuns"),
  listSuiteSelections: makeFunctionReference<
    "query",
    { suiteId: string },
    SuiteWebAccountSelection[]
  >("webClients:listSuiteWebAccountSelections"),
  setSuiteSelection: makeFunctionReference<
    "mutation",
    { suiteId: string; vendor: WebClientVendor; webAccountIds: string[] },
    null
  >("webClients:setSuiteWebAccountSelection"),
};
