import { connectionKey, type McpToolConnection } from "@mcpjam/sdk";
import { connectionLabels } from "../../shared/oauth-connections.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import type { ConvexBatchAuthorizeSuccess } from "../routes/web/auth.js";

/**
 * Exactly which accounts each server runs with for the acting person, keyed
 * by server id. Sent to the backend, which resolves only these accounts'
 * tokens, and checked again here so a run never falls back to an account
 * nobody chose.
 */
export type ConnectionIdSets = Readonly<Record<string, readonly string[]>>;

/** The refusal for a request pinned to one saved account, such as a task. */
export const SAVED_ACCOUNT_UNAVAILABLE =
  "The account saved with this task is unavailable. Reconnect that account to continue.";

/**
 * The account group a server runs with when its launcher sent a set, or
 * `undefined` when no chosen account applies: a server not on OAuth. A set
 * names the person's own accounts or, on a server shared with the project,
 * the project's accounts; the backend answers both the same way.
 *
 * The base account owns the bare server key, which run-level lookups such as
 * the tool snapshot use. It is the default account when chosen, otherwise the
 * first chosen account, so leaving the default out never leaves the key empty.
 *
 * Names never carry an email, because a teammate can open the run, and the
 * profile email is dropped so the model's account descriptions do not carry
 * it either.
 */
export function accountSetGroup(args: {
  serverId: string;
  serverName: string;
  auth: ConvexBatchAuthorizeSuccess;
  set: readonly string[];
  /** Replaces every refusal message below, for callers with their own copy. */
  refusal?: string;
}): McpToolConnection[] | undefined {
  const { serverId, serverName, auth, set } = args;
  const refuse: (message: string) => never = (message) => {
    throw new WebRouteError(403, ErrorCode.FORBIDDEN, args.refusal ?? message);
  };
  if (auth.oauthAccountSet !== "applied") {
    // A token without the backend's answer means the set was ignored, and
    // that token is the default account's.
    if (auth.oauthAccessToken) {
      refuse(
        `MCPJam couldn't confirm which ${serverName} account this run would use, so it didn't start. Try again in a few minutes.`,
      );
    }
    return undefined;
  }
  if (!set.length) {
    refuse(
      `No ${serverName} account is chosen for this suite. Choose one in the suite's settings.`,
    );
  }
  const listed = auth.oauthConnections ?? [];
  // The backend names accounts over the server's whole list, so a name here
  // matches the one in suite settings; the local rule covers an older backend.
  const fallback = connectionLabels(listed, { withoutEmail: true });
  const labels = listed.map((c, index) => c.displayName ?? fallback[index]);
  const byId = new Map(
    listed.map((c, index) => [c.connectionId, { c, label: labels[index] }]),
  );
  const chosen = set.map((id) => {
    const entry = byId.get(id);
    if (!entry) {
      refuse(
        `An account chosen for ${serverName} was removed. Choose ${serverName}'s accounts again in the suite's settings.`,
      );
    }
    if (!entry.c.accessToken || entry.c.needsReauth) {
      refuse(
        `${serverName} ${entry.label} needs reconnect. Reconnect it in Authorization, or choose another account in the suite's settings.`,
      );
    }
    return entry;
  });
  const baseId = (chosen.find(({ c }) => c.isDefault) ?? chosen[0]).c
    .connectionId;
  return chosen.map(({ c, label }) => ({
    serverId,
    connectionId: c.connectionId,
    key: connectionKey(serverId, c.connectionId, c.connectionId === baseId),
    label,
    // An address used as the profile id would reach teammates too.
    ...(c.profile && !c.profile.id.includes("@")
      ? {
          profile: {
            id: c.profile.id,
            ...(c.profile.name && !c.profile.name.includes("@")
              ? { name: c.profile.name }
              : {}),
            ...(c.profile.nickname && !c.profile.nickname.includes("@")
              ? { nickname: c.profile.nickname }
              : {}),
          },
        }
      : {}),
    isDefault: c.connectionId === baseId,
  }));
}
