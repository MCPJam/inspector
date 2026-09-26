import type { HostedOAuthCallbackContext } from "../hosted-oauth-callback";

export type ProjectOAuthAccess =
  "wait" | "allow" | "legacy" | "identity" | "membership";
export function checkProjectOAuthAccess(
  context: HostedOAuthCallbackContext,
  auth: {
    loading: boolean;
    userId: string | null;
    projectIds?: ReadonlySet<string>;
  },
): ProjectOAuthAccess {
  if (auth.loading) return "wait";
  if (context.initiatingUserId === undefined) return "legacy";
  if (context.initiatingUserId !== auth.userId) return "identity";
  if (context.projectId) {
    if (!auth.projectIds) return "wait";
    if (!auth.projectIds.has(context.projectId)) return "membership";
  }
  return "allow";
}
