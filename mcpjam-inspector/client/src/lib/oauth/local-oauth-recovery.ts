import {
  fetchOAuthRecoveryHeaders,
  fetchServerSecrets,
  stageOAuthRecoveryHeaders,
} from "@/lib/apis/server-secrets-api";

export function withoutOAuthAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
}

export async function resolveLocalOAuthHeaders(
  headers: Record<string, string> | undefined,
  binding: { projectId: string; serverId: string } | undefined,
  hasSavedHeaders: boolean,
): Promise<Record<string, string>> {
  // Browser-initiated local auth uses the existing edit-purpose permissions;
  // runtime-purpose secrets must never be revealed through a browser route.
  const stored =
    hasSavedHeaders && binding
      ? (
          await fetchServerSecrets({
            projectId: binding.projectId,
            serverId: binding.serverId,
          })
        ).headers
      : undefined;
  return withoutOAuthAuthorizationHeader({ ...stored, ...headers });
}

export async function stageLocalOAuthHeaders(
  serverName: string,
  serverUrl: string,
  headers: Record<string, string> | undefined,
): Promise<void> {
  const key = `mcp-oauth-recovery-handle-${serverName}`;
  sessionStorage.removeItem(key);
  const selected = withoutOAuthAuthorizationHeader(headers);
  if (Object.keys(selected).length === 0) return;
  // A UUID uses the same URL-safe alphabet accepted by the recovery route.
  const recoveryHandle = crypto.randomUUID();
  await stageOAuthRecoveryHeaders({
    serverName,
    serverUrl,
    recoveryHandle,
    headers: selected,
  });
  sessionStorage.setItem(key, recoveryHandle);
}

export async function recoverLocalOAuthHeaders(
  serverName: string,
  serverUrl: string,
  config: {
    hasCustomHeaders?: boolean;
    customHeaders?: Record<string, string>;
  },
): Promise<Record<string, string> | undefined> {
  const legacy = withoutOAuthAuthorizationHeader(config.customHeaders);
  if (Object.keys(legacy).length) return legacy;
  if (!config.hasCustomHeaders) return undefined;
  const key = `mcp-oauth-recovery-handle-${serverName}`;
  const recoveryHandle = sessionStorage.getItem(key);
  if (!recoveryHandle)
    throw new Error(
      "OAuth custom headers are no longer available. Save them again and retry authorization.",
    );
  const headers = await fetchOAuthRecoveryHeaders({
    serverName,
    serverUrl,
    recoveryHandle,
  });
  if (!Object.keys(headers).length)
    throw new Error(
      "OAuth custom headers are no longer available. Save them again and retry authorization.",
    );
  sessionStorage.removeItem(key);
  return headers;
}
