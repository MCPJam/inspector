import { useMutation } from "convex/react";
import {
  ConnectionAccountsList,
  type AccountListTerms,
} from "@/components/connection/ConnectionAccountsSection";
import { LocalRunsControl } from "@/components/connection/LocalRunsControl";
import { FocusBlock } from "@/components/hosts/redesigned/focus/primitives";
import { useWebAccounts } from "@/hooks/use-web-accounts";
import { webAccountsApi } from "@/lib/web-accounts/api";
import {
  webAccountAsConnection,
  webClientSite,
} from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/** A web account is a saved sign-in to the vendor's site, so it is signed into. */
export const WEB_ACCOUNT_TERMS: AccountListTerms = {
  needsReauth: "Needs sign-in",
  // No `reauthenticate`: nothing here can sign a saved account in again, so
  // the row's menu doesn't offer it.
  removeBody: "MCPJam will remove this account and its saved sign-in.",
};

/**
 * The client's accounts on its Browser settings tab, in the list MCP servers
 * share, with the same rules: admins manage, members' runs use them, and
 * local apps get them only when an admin allows it. Accounts are added and
 * signed in from the playground's pane, in the browser the runs use, so the
 * list here offers neither.
 */
export function WebAccountsSettings({
  projectId,
  vendor,
}: {
  projectId: string;
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
  // A member reads the notice under the list as covering every account in it.
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
