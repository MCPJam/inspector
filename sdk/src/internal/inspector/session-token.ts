import { readFileSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { operationalError } from "./errors.js";
import { isLoopbackHostname, normalizeInspectorBaseUrl } from "./urls.js";

const SESSION_TOKEN_TIMEOUT_MS = 3_000;

const TOKEN_TTL_MS = 5 * 60_000;
const tokenCache = new Map<string, { token: string; fetchedAt: number }>();
const tokenRequests = new Map<string, Promise<string>>();

export async function fetchInspectorSessionToken(
  baseUrl: string,
): Promise<string> {
  const normalizedBaseUrl = normalizeInspectorBaseUrl(baseUrl);
  const cached = tokenCache.get(normalizedBaseUrl);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
    return cached.token;
  }

  const pending = tokenRequests.get(normalizedBaseUrl);
  if (pending) {
    return pending;
  }

  const request = fetchFreshInspectorSessionToken(normalizedBaseUrl).finally(
    () => {
      tokenRequests.delete(normalizedBaseUrl);
    },
  );
  tokenRequests.set(normalizedBaseUrl, request);
  return request;
}

export function clearInspectorSessionTokenCache(baseUrl?: string): void {
  if (!baseUrl) {
    tokenCache.clear();
    tokenRequests.clear();
    return;
  }

  const normalizedBaseUrl = normalizeInspectorBaseUrl(baseUrl);
  tokenCache.delete(normalizedBaseUrl);
  tokenRequests.delete(normalizedBaseUrl);
}

async function fetchFreshInspectorSessionToken(
  normalizedBaseUrl: string,
): Promise<string> {
  const endpoint = new URL(normalizedBaseUrl);
  if (!isLoopbackHostname(endpoint.hostname))
    throw operationalError("Inspector attachment requires a local address.");
  let token: string;
  try {
    const file = path.join(
      os.homedir(),
      ".mcpjam",
      "inspector",
      `${endpoint.port || "6274"}.json`
    );
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Unsafe discovery file permissions");
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (
      record.port !== Number(endpoint.port || "6274") ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.token !== "string" ||
      !/^[A-Za-z0-9_-]{24,}$/.test(record.token)
    )
      throw new Error("Invalid discovery file");
    process.kill(record.pid, 0);
    token = record.token;
  } catch {
    throw operationalError(
      "Cannot read this Inspector's access file. Start or restart an updated Inspector as the same user, then try again."
    );
  }
  let response: Response;
  try {
    response = await fetch(`${normalizedBaseUrl}/api/session-token`, {
      headers: {
        "X-MCP-Session-Auth": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(SESSION_TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw operationalError(
      "Failed to contact the local Inspector session-token endpoint.",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    throw operationalError(
      `Inspector session-token request failed with ${response.status}.`,
    );
  }

  const body = (await response.json()) as { ok?: unknown };
  if (body.ok !== true) {
    throw operationalError("Inspector session-token response was invalid.");
  }

  tokenCache.set(normalizedBaseUrl, {
    token,
    fetchedAt: Date.now(),
  });
  return token;
}

export function isAuthFailure(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}
