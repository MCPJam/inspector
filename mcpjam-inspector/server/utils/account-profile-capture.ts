import { captureOpenAIProfile, type MCPClientManager } from "@mcpjam/sdk";
import { logger } from "./logger.js";
import { getManagerConnections, managerAccountsAtRun } from "./mcp-connections.js";

/** One connected account: its key in the manager and its stored credential. */
export type AccountCaptureTarget = {
  key: string;
  serverId: string;
  connectionId: string;
};

type CaptureManager = Pick<MCPClientManager, "listTools" | "executeTool">;

const PROFILE_FIELDS = ["id", "name", "email", "nickname"] as const;

/**
 * Ask the server's profile tool who one connected account is, and record the
 * answer when it changed. The write names the stored token the backend
 * described (`expectedVaultObjectId`), so an answer about a token replaced in
 * the meantime is dropped. With `hostedOnly`, only a shared or uploaded
 * account is asked: its identity is kept for eval runs to show. The backend
 * answers nothing for an account the caller may not write, and an older
 * backend nothing for these accounts, so neither costs a tool call.
 */
export async function captureAccountProfile(
  manager: CaptureManager,
  target: AccountCaptureTarget,
  options: {
    bearer: string;
    projectId: string;
    timeoutMs?: number;
    hostedOnly?: boolean;
  },
): Promise<void> {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) return;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const post = (operation: string, body: unknown) =>
    fetch(`${url}/web/oauth/connections/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  const base = {
    projectId: options.projectId,
    serverId: target.serverId,
    connectionId: target.connectionId,
  };
  const contextResponse = await post("capture-context", base);
  if (!contextResponse.ok) return;
  const context = await contextResponse.json();
  if (!context.expectedVaultObjectId || signal.aborted) return;
  if (options.hostedOnly && context.hostedOnly !== true) return;
  const captured = await captureOpenAIProfile(manager, target.key, {
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
  });
  if (
    !captured.profile ||
    signal.aborted ||
    PROFILE_FIELDS.every(
      (field) => captured.profile?.[field] === context.profile?.[field],
    )
  )
    return;
  await post("profile", {
    ...base,
    profile: captured.profile,
    expectedVaultObjectId: context.expectedVaultObjectId,
  });
}

/** Whether an authorized account is shared with the project or uploaded. */
export function isHostedOnlyAccount(
  account: { accountKind?: string; accountUploaded?: boolean } | undefined,
): boolean {
  return (
    account?.accountKind === "shared" ||
    account?.accountKind === "uploaded" ||
    account?.accountUploaded === true
  );
}

/**
 * The accounts a connected server authorized with: its account group, or the
 * one stored credential its base key connected on.
 */
export function connectedAccounts(
  manager: MCPClientManager,
  serverId: string,
): AccountCaptureTarget[] {
  const group = getManagerConnections(manager)?.[serverId];
  if (group?.length)
    return group.map((c) => ({
      key: c.key,
      serverId: c.serverId,
      connectionId: c.connectionId,
    }));
  const ids =
    managerAccountsAtRun(manager).find((entry) => entry.serverId === serverId)
      ?.connectionIds ?? [];
  return ids.slice(0, 1).map((connectionId) => ({
    key: serverId,
    serverId,
    connectionId,
  }));
}

/**
 * On connect, capture the identity of every shared or uploaded account the
 * connection used, together and within one budget. Never rejects: a server
 * without a profile tool, or a refusal, leaves the connect as it was.
 */
export async function captureHostedOnlyAccountProfiles(
  manager: CaptureManager,
  targets: readonly AccountCaptureTarget[],
  options: { bearer: string; projectId: string; timeoutMs?: number },
): Promise<void> {
  if (!options.bearer || targets.length === 0) return;
  const results = await Promise.allSettled(
    targets.map((target) =>
      captureAccountProfile(manager, target, { ...options, hostedOnly: true }),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected")
      logger.debug("Account identity capture failed", {
        serverId: targets[index].serverId,
        error:
          result.reason instanceof Error
            ? result.reason.name
            : typeof result.reason,
      });
  });
}
