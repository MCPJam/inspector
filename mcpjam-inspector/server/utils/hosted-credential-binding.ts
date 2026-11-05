import { logger } from "./logger.js";

/**
 * Which credential a saved call used, and so how a sign-in may settle it
 *:
 *
 *   - `none`: the call used no credential (a tokenless first sign-in). The
 *     sign-in creates a personal connection, and the resume may bind to it.
 *   - `owned`: the initiating user's own credential. Reauthorized in place;
 *     the resume must land on that very credential.
 *   - `shared`: a project credential, or one the user does not own. Never
 *     replaced: the user signs in with their own account and runs the tool
 *     again, so the saved call is never replayed across credentials.
 */
export type HostedCredentialBinding =
  | { kind: "none" }
  | { kind: "owned"; credentialId: string }
  | { kind: "shared"; credentialId?: string };

export function isCredentialBinding(
  value: unknown,
): value is HostedCredentialBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as { kind?: unknown; credentialId?: unknown };
  if (binding.kind === "none") return true;
  if (binding.kind === "owned") {
    return (
      typeof binding.credentialId === "string" && binding.credentialId !== ""
    );
  }
  return (
    binding.kind === "shared" &&
    (binding.credentialId === undefined ||
      typeof binding.credentialId === "string")
  );
}

/**
 * Whether a resumed call may run on the credential the rebuilt connection
 * resolves to.
 *
 * - The call used a credential: only that same credential. A sign-in that
 *   produced another one (an account switch at the authorization server, or a
 *   personal connection made beside a shared one) is not a reauthorization of
 *   the call's credential, and the client cancels instead of resuming.
 * - The call used none (a tokenless first sign-in): the first binding is
 *   allowed. The continuation is already pinned to this server
 *   (`claimed.state.serverId`) and, through the binding fingerprint's auth
 *   principal, to the user who started it, so the credential the rebuilt
 *   connection resolves to is the one that user just authorized.
 */
export function checkResumeCredentialBinding(
  recordedConnectionId: string | undefined,
  resolvedConnectionId: string | undefined,
): { ok: true; firstBinding: boolean } | { ok: false } {
  if (!recordedConnectionId) return { ok: true, firstBinding: true };
  return resolvedConnectionId === recordedConnectionId
    ? { ok: true, firstBinding: false }
    : { ok: false };
}

/**
 * The resume check for a continuation that recorded its credential binding
 *. A shared credential is never resumed: the sign-in made a personal
 * connection, and replaying onto it would run the call on another account.
 */
export function checkRecordedCredentialBinding(
  recorded: HostedCredentialBinding,
  resolvedConnectionId: string | undefined,
): { ok: true; firstBinding: boolean } | { ok: false } {
  switch (recorded.kind) {
    case "none":
      return checkResumeCredentialBinding(undefined, resolvedConnectionId);
    case "owned":
      return checkResumeCredentialBinding(
        recorded.credentialId,
        resolvedConnectionId,
      );
    case "shared":
      return { ok: false };
  }
}

/**
 * Whether the initiating user owns this credential, from the same listing the
 * client reads (`/web/oauth/connections`): a personal row, and not the
 * project's shared one. Anything else, including a failed lookup, is not
 * theirs; a credential that cannot be proven owned is never replaced.
 */
export async function ownsHostedCredential(input: {
  bearer: string;
  projectId: string;
  serverId: string;
  connectionId: string;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) return false;
  try {
    const response = await fetch(`${convexUrl}/web/oauth/connections`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: input.bearer.startsWith("Bearer ")
          ? input.bearer
          : `Bearer ${input.bearer}`,
      },
      body: JSON.stringify({
        projectId: input.projectId,
        serverId: input.serverId,
      }),
      signal: input.abortSignal
        ? AbortSignal.any([input.abortSignal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      connections?: Array<{ connectionId?: unknown }>;
      shared?: unknown;
    };
    return (
      body.shared !== true &&
      Array.isArray(body.connections) &&
      body.connections.some(
        (connection) => connection?.connectionId === input.connectionId,
      )
    );
  } catch (error) {
    logger.warn("[auth-challenge] credential ownership lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function resolveHostedCredentialBinding(input: {
  bearer: string;
  projectId: string;
  serverId: string;
  connectionId?: string;
  abortSignal?: AbortSignal;
  ownsCredential?: (connectionId: string) => Promise<boolean>;
}): Promise<HostedCredentialBinding> {
  // Hosted chat stamps attribution on every call made with a live OAuth
  // credential, so a call without one used none.
  if (!input.connectionId) return { kind: "none" };
  const connectionId = input.connectionId;
  const owned = input.ownsCredential
    ? await input.ownsCredential(connectionId).catch(() => false)
    : await ownsHostedCredential({ ...input, connectionId });
  return owned
    ? { kind: "owned", credentialId: connectionId }
    : { kind: "shared", credentialId: connectionId };
}
