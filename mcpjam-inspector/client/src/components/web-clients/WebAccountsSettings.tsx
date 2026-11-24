import { useMutation } from "convex/react";
import {
  ConnectionAccountsList,
  type AccountListTerms,
} from "@/components/connection/ConnectionAccountsSection";
import { LocalRunsControl } from "@/components/connection/LocalRunsControl";
import { FocusBlock } from "@/components/hosts/redesigned/focus/primitives";
import { useWebAccounts } from "@/hooks/use-web-accounts";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { savePreviewedHostId } from "@/lib/previewed-client-storage";
import { webAccountsApi } from "@/lib/web-accounts/api";
import {
  webAccountAsConnection,
  webAccountReconnectPath,
  webClientSite,
} from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/** A web account is a saved sign-in to the vendor's site, so it is signed into. */
export const WEB_ACCOUNT_TERMS: AccountListTerms = {
  needsReauth: "Needs sign-in",
  reauthenticate: "Sign in again",
  removeBody: "MCPJam will remove this account and its saved sign-in.",
};

/**
 * The client's accounts on its Browser settings tab, in the list MCP servers
 * share, with the same rules: admins manage, members' runs use them, and
 * local apps get them only when an admin allows it. Signing in happens in the
 * playground's pane, in the browser the runs use.
 */
export function WebAccountsSettings({
  projectId,
  hostId,
  vendor,
}: {
  projectId: string;
  hostId: string;
  vendor: WebClientVendor;
}) {
  const { accounts, loaded, isAdmin } = useWebAccounts(projectId, vendor);
  const rename = useMutation(webAccountsApi.rename);
  const setDefault = useMutation(webAccountsApi.setDefault);
  const remove = useMutation(webAccountsApi.remove);
  const setAllowLocalRuns = useMutation(webAccountsApi.setAllowLocalRuns);
  // On while any account allows local runs, so Stop revokes a mixed state in
  // one step instead of after allowing the rest.
  const localRunsAllowed = accounts.some((account) => account.allowLocalRuns);
  // The notes under the list and under the switch read as covering every
  // account, so a mixed state can't use the words for all of them.
  const everyAccountAllowsLocalRuns =
    accounts.length > 0 && accounts.every((account) => account.allowLocalRuns);
  return (
    <FocusBlock
      title="Accounts"
      subtitle={`The ${webClientSite(vendor)} accounts this client's runs sign in as.`}
    >
      <ConnectionAccountsList
        connections={accounts.map(webAccountAsConnection)}
        shared={loaded ? true : undefined}
        isAdmin={isAdmin}
        localDeliveryAllowed={everyAccountAllowsLocalRuns}
        terms={WEB_ACCOUNT_TERMS}
        sharingControl={
          isAdmin && accounts.length ? (
            <LocalRunsControl
              noun="client"
              allowed={localRunsAllowed}
              allowedNote={
                everyAccountAllowsLocalRuns
                  ? undefined
                  : "Some of these accounts' saved sign-ins can be used by members' local apps. Stop turns all of them off."
              }
              onChange={async (allowLocalRuns) => {
                await Promise.all(
                  accounts.map(({ webAccountId }) =>
                    setAllowLocalRuns({ webAccountId, allowLocalRuns }),
                  ),
                );
              }}
            />
          ) : null
        }
        onAuthenticate={(intent) => {
          // Signing in again opens that account's own page; a new account
          // starts in the playground's pane, in the browser runs use.
          if (intent.kind === "replace") {
            navigateApp(
              webAccountReconnectPath(intent.credentialId, projectId),
            );
            return;
          }
          savePreviewedHostId(projectId, hostId);
          navigateApp(routePaths.playground);
        }}
        onUpdate={async ({ connectionId: webAccountId }, operation, label) => {
          if (operation === "label")
            await rename({ webAccountId, label: label ?? "" });
          else if (operation === "default") await setDefault({ webAccountId });
          else await remove({ webAccountId });
        }}
      />
    </FocusBlock>
  );
}
