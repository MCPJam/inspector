import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEvalAccountSelectionEnabled } from "@/hooks/useEvalAccountSelectionEnabled";
import { useCanManageProjectClients } from "@/hooks/useProjects";
import { notifyOAuthConnectionsChanged } from "@/lib/apis/web/oauth-connections";

/** `personal`: each member signs in. `shared`: the project's accounts. */
export type OAuthSharing = "personal" | "shared";

const setServerOAuthSharing = makeFunctionReference<
  "mutation",
  {
    serverId: string;
    oauthSharing: OAuthSharing;
    acknowledgeLocalDelivery?: boolean;
  },
  { oauthSharing: OAuthSharing }
>("servers:setServerOAuthSharing");

const setServerLocalDelivery = makeFunctionReference<
  "mutation",
  { serverId: string; allowed: boolean },
  { localDeliveryAllowed: boolean }
>("credentials:setServerLocalDelivery");

/**
 * Who may share a server's sign-in with its project, and the writes that do
 * it.
 *
 * Sharing, un-sharing, allowing local runs and every write to a project
 * account are admin-only on the backend (`canManageSharedConnections`, which
 * is `canManageProjectMembers`). `useCanManageProjectClients` mirrors that
 * same check from `getMyProjects`, and reads false until it loads, so nothing
 * is offered that the backend would refuse.
 *
 * The control also waits for `eval-account-selection-enabled`: several
 * project accounts are only useful once a suite can choose among them.
 */
export function useSignInSharing({
  projectId,
  serverId,
  enabled,
}: {
  projectId?: string | null;
  serverId?: string | null;
  enabled: boolean;
}) {
  const flagOn = useEvalAccountSelectionEnabled();
  const { canManage } = useCanManageProjectClients({
    isAuthenticated: enabled,
    projectId,
  });
  const save = useMutation(setServerOAuthSharing);
  const saveLocalDelivery = useMutation(setServerLocalDelivery);
  return {
    /** Manages a shared server's accounts; on a personal one, everyone manages their own. */
    isAdmin: canManage,
    canShare: canManage && flagOn,
    setSharing: async (oauthSharing: OAuthSharing) => {
      if (!serverId) return;
      // The share dialog says members' local apps receive the accounts'
      // tokens, so sharing from it also allows local runs.
      await save({
        serverId,
        oauthSharing,
        ...(oauthSharing === "shared"
          ? { acknowledgeLocalDelivery: true }
          : {}),
      });
      // After the change the server lists the other kind of account.
      notifyOAuthConnectionsChanged();
    },
    /** Allow, or stop, members' local apps receiving the shared accounts' tokens. */
    setLocalRuns: async (allowed: boolean) => {
      if (!serverId) return;
      await saveLocalDelivery({ serverId, allowed });
      notifyOAuthConnectionsChanged();
    },
  };
}
