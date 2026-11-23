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

/**
 * The clients a person may pick. Claude web and ChatGPT web stay out while
 * their flag is off, even in a project that made them while it was on. One
 * already picked (`keep`) stays listed, so it still shows by name and can be
 * unpicked; it just can't be picked again.
 */
export function pickableHosts<
  T extends Parameters<typeof webClientVendorOfHost>[0] & { hostId: string },
>(
  hosts: readonly T[],
  webClientsEnabled: boolean,
  keep: Iterable<string | null | undefined> = [],
): T[] {
  if (webClientsEnabled) return [...hosts];
  const kept = new Set(keep);
  return hosts.filter(
    (host) => kept.has(host.hostId) || !webClientVendorOfHost(host),
  );
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

/** How the chip and the suite name an account: its address, else its name. */
export function webAccountName(account: WebAccount): string {
  return account.accountEmail || account.label;
}

/**
 * Whether anyone ever signed this account in. A new account also reads
 * `needs_sign_in`, but the site never signed it out, so it is told apart.
 */
export function webAccountWasSignedIn(account: WebAccount): boolean {
  return account.hasProfile || account.lastVerifiedAt !== undefined;
}

/**
 * A name for a new account before anyone has signed in, unused among the
 * client's accounts, since the backend refuses a second account by one name.
 */
export function newWebAccountLabel(
  vendor: WebClientVendor,
  accounts: readonly WebAccount[],
): string {
  const taken = new Set(accounts.map(({ label }) => label.toLowerCase()));
  const base = `${webClientName(vendor)} account`;
  let label = base;
  for (let n = 2; taken.has(label.toLowerCase()); n += 1)
    label = `${base} ${n}`;
  return label;
}

/** The page an admin signs an account in again on; the backend's email links here. */
export function webAccountReconnectPath(
  webAccountId: string,
  projectId: string,
  requestId?: string,
): string {
  const query = new URLSearchParams(
    requestId
      ? { request: requestId, project: projectId }
      : { project: projectId },
  );
  return `/web-accounts/${encodeURIComponent(webAccountId)}/reconnect?${query}`;
}
