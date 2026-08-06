import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface FetchServerSecretsRequest {
  projectId: string;
  serverId: string;
}

export interface ServerSecretsResult {
  env: Record<string, string> | null;
  headers: Record<string, string> | null;
}

export interface ServerSecretKeysResult {
  envKeys: string[];
  headerKeys: string[];
}

function parseRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      const [key, recordValue] = entry;
      return typeof key === "string" && typeof recordValue === "string";
    })
  );
}

function parseKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Which env vars / headers a server has stored, by name only.
 *
 * Lets the edit form name its rows — "OPENAI_API_KEY is set" — without pulling
 * the values across. The values stay on the server until `fetchServerSecrets`,
 * which a row's eye triggers.
 */
export async function fetchServerSecretKeys(
  request: FetchServerSecretsRequest
): Promise<ServerSecretKeysResult> {
  const body = await webPost<FetchServerSecretsRequest, unknown>(
    "/api/web/server/secret-keys",
    request
  );
  const result =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!result?.success) {
    throw new WebApiError(
      0,
      "INVALID_RESPONSE",
      "Server secret keys response was invalid"
    );
  }

  return {
    envKeys: parseKeys(result.envKeys),
    headerKeys: parseKeys(result.headerKeys),
  };
}

export async function fetchServerSecrets(
  request: FetchServerSecretsRequest
): Promise<ServerSecretsResult> {
  const body = await webPost<FetchServerSecretsRequest, unknown>(
    "/api/web/server/reveal-secrets",
    request
  );
  const result =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!result?.success) {
    throw new WebApiError(
      0,
      "INVALID_RESPONSE",
      "Server secrets response was invalid"
    );
  }

  return {
    env: parseRecord(result.env),
    headers: parseRecord(result.headers),
  };
}
