/**
 * Which MCPJam server a Node caller talks to. Every CLI command and every SDK
 * Node entry point uses this one order; the first source that names a server
 * wins:
 *
 *   1. the caller's flag or option (`--api-url`, an SDK `baseUrl`)
 *   2. `MCPJAM_API_URL`, or `MCPJAM_BASE_URL` (the same server, older format)
 *   3. the saved login's server, when the saved login is the credential in use
 *   4. MCPJam Cloud
 *
 * A saved login only goes to the server it was made against. When it is the
 * credential and the order picks another server, this refuses before anything
 * is sent, so a staging token never reaches production or the reverse.
 */
import { getAuthFilePath, readStoredAuth } from "../platform-auth-store.js";
import {
  deploymentFromEnv,
  MCPJAM_CLOUD,
  McpjamDeploymentError,
  parseApiUrl,
  parseBaseUrl,
  sameServer,
  tryParseApiUrl,
  type DeploymentAddress,
  type DeploymentSource,
} from "./address.js";

/**
 * The credential the caller will send:
 * - `oauth`: the saved login. Its server is a source, and any other is refused.
 * - `none`: nothing yet (`cloud login`). The saved login's server is only the
 *   default, so a stale login never blocks signing in somewhere else.
 * - `api-key`: an explicit key. The saved login is ignored and never sent.
 */
export type DeploymentCredential = "api-key" | "oauth" | "none";

export interface ResolvedDeployment extends DeploymentAddress {
  source: DeploymentSource;
}

export interface ResolveDeploymentInput {
  /** An explicit API base: `--api-url`, an SDK `apiUrl` option. */
  apiUrl?: string;
  /** An explicit app base: an SDK `baseUrl` option. `apiUrl` wins over it. */
  baseUrl?: string;
  /** Defaults to `api-key`, which never consults the saved login. */
  credential?: DeploymentCredential;
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
}

function explicitAddress(
  input: ResolveDeploymentInput
): DeploymentAddress | undefined {
  const apiUrl = input.apiUrl?.trim();
  if (apiUrl) return parseApiUrl(apiUrl, "--api-url", "flag");
  const baseUrl = input.baseUrl?.trim();
  if (baseUrl) return parseBaseUrl(baseUrl, "baseUrl", "flag");
  return undefined;
}

/**
 * The server the saved login was made against. A login written before logins
 * recorded their server is an MCPJam Cloud login, and so is one whose recorded
 * server no longer parses: `readStoredAuth` already drops unparsable values.
 */
function savedLoginAddress(
  input: ResolveDeploymentInput,
  env: NodeJS.ProcessEnv
): DeploymentAddress | undefined {
  const stored = readStoredAuth(input.authFilePath ?? getAuthFilePath({ env }));
  if (!stored) return undefined;
  return (stored.apiUrl && tryParseApiUrl(stored.apiUrl)) || MCPJAM_CLOUD;
}

function loginMismatch(
  saved: DeploymentAddress,
  chosen: ResolvedDeployment
): McpjamDeploymentError {
  const login =
    chosen.source === "flag"
      ? `mcpjam cloud login --api-url ${chosen.apiUrl}`
      : "mcpjam cloud login";
  return new McpjamDeploymentError(
    "LOGIN_DEPLOYMENT_MISMATCH",
    `Your saved login is for ${saved.apiUrl}; this command targets ${chosen.apiUrl}. Run \`${login}\` to sign in there, or use an API key for that server.`,
    { apiUrl: chosen.apiUrl, source: chosen.source }
  );
}

/** Throws {@link McpjamDeploymentError} before anything is sent. */
export function resolveDeployment(
  input: ResolveDeploymentInput = {}
): ResolvedDeployment {
  const env = input.env ?? process.env;
  const credential = input.credential ?? "api-key";
  const explicit = explicitAddress(input);
  const fromEnv = deploymentFromEnv(env);
  const saved =
    credential === "api-key" ? undefined : savedLoginAddress(input, env);

  const chosen: ResolvedDeployment = explicit
    ? { ...explicit, source: "flag" }
    : fromEnv
      ? { ...fromEnv, source: "env" }
      : saved
        ? { ...saved, source: "oauth" }
        : { ...MCPJAM_CLOUD, source: "default" };

  if (credential === "oauth" && saved && !sameServer(saved, chosen)) {
    throw loginMismatch(saved, chosen);
  }
  return chosen;
}
