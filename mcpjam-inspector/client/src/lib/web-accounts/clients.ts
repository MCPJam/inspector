import { harnessTargetOfHost } from "@/lib/harness-model-locks";
import type { OAuthConnection } from "@/shared/oauth-connections";
import {
  WEB_CLIENT_DISPLAY_NAMES,
  WEB_CLIENT_SITES,
  webClientVendorForRuntime,
  type WebClientVendor,
} from "@/shared/web-clients";
import type { WebAccount } from "./api";

/** Which web client a client is, read from the runtime it runs on. */
export function webClientVendorOfHost(host: {
  runtime?: string | null;
  harness?: string | null;
  agentLoop?: string | null;
}): WebClientVendor | undefined {
  const target = harnessTargetOfHost(host);
  return target ? webClientVendorForRuntime(target.harnessId) : undefined;
}

/** The vendor's site as people know it, such as claude.ai. */
export function webClientSite(vendor: WebClientVendor): string {
  return new URL(WEB_CLIENT_SITES[vendor][0]).host;
}

export function webClientName(vendor: WebClientVendor): string {
  return WEB_CLIENT_DISPLAY_NAMES[vendor];
}

/** A web account as a row of the account list that MCP servers share. */
export function webAccountAsConnection(account: WebAccount): OAuthConnection {
  return {
    connectionId: account.webAccountId,
    label: account.label,
    isDefault: account.isDefault,
    needsReauth: account.status === "needs_sign_in",
    profile: account.accountEmail
      ? {
          id: account.webAccountId,
          email: account.accountEmail,
          name: account.workspaceName,
        }
      : undefined,
  };
}

/** The account a run uses when nothing else is chosen: the default. */
export function runAccountOf(accounts: readonly WebAccount[]) {
  return accounts.find((account) => account.isDefault) ?? accounts[0];
}

/** How the list and the chip name an account. */
export function webAccountName(account: WebAccount): string {
  return account.accountEmail || account.label || "Unnamed account";
}
