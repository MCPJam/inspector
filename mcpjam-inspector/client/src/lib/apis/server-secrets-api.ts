import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface FetchServerSecretsRequest {
  projectId: string;
  serverId: string;
}

export interface ServerSecretsResult {
  env: Record<string, string> | null;
  headers: Record<string, string> | null;
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
