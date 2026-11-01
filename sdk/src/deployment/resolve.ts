/**
 * Which MCPJam server a Node caller talks to. Every CLI command and every SDK
 * Node entry point uses this one order; the first source that names a server
 * wins, and a locked IT file overrides everything below it:
 *
 *   1. the IT settings file, with "lock": true
 *   2. the caller's flag or option (`--api-url`, an SDK `baseUrl`)
 *   3. `MCPJAM_API_URL`, or `MCPJAM_BASE_URL` (the same server, older format)
 *   4. the saved login's server, when the saved login is the credential in use
 *   5. the IT settings file, with "lock": false (the organization default)
 *   6. MCPJam Cloud
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
import {
  managedSettingsProblem,
  readManagedSettings,
} from "./managed-settings.js";

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
  /** How `apiUrl` is named in errors. Defaults to `--api-url`. */
  apiUrlLabel?: string;
  /** An explicit app base: an SDK `baseUrl` option. `apiUrl` wins over it. */
  baseUrl?: string;
  /** Defaults to `api-key`, which never consults the saved login. */
  credential?: DeploymentCredential;
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
}

/** A server a flag or variable named, with the name to quote in a refusal. */
type Named = DeploymentAddress & { label: string; source: "flag" | "env" };

function explicitAddress(input: ResolveDeploymentInput): Named | undefined {
  const apiUrl = input.apiUrl?.trim();
  const label = input.apiUrlLabel ?? "--api-url";
  if (apiUrl) {
    return { ...parseApiUrl(apiUrl, label, "flag"), label, source: "flag" };
  }
  const baseUrl = input.baseUrl?.trim();
  if (baseUrl) {
    const address = parseBaseUrl(baseUrl, "baseUrl", "flag");
    return { ...address, label: "baseUrl", source: "flag" };
  }
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

function at(
  address: DeploymentAddress,
  source: DeploymentSource
): ResolvedDeployment {
  return { apiUrl: address.apiUrl, baseUrl: address.baseUrl, source };
}

function lockRefusal(
  locked: ResolvedDeployment,
  path: string,
  other: Named
): McpjamDeploymentError {
  return new McpjamDeploymentError(
    "DEPLOYMENT_LOCKED",
    `Your organization locks MCPJam to ${locked.apiUrl} (${path}), and ${other.label} names ${other.apiUrl}, so nothing was sent. Remove ${other.label}, or set it to ${locked.apiUrl}.`,
    { apiUrl: other.apiUrl, source: other.source }
  );
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
  const managed = readManagedSettings();
  if (managed.state === "invalid") {
    throw new McpjamDeploymentError(
      "MANAGED_SETTINGS_INVALID",
      managedSettingsProblem(managed),
      { source: "managed" }
    );
  }
  const explicit = explicitAddress(input);
  const fromEnv = deploymentFromEnv(env);
  const named: Named | undefined = fromEnv && {
    ...fromEnv,
    label: fromEnv.variable,
    source: "env",
  };
  const saved =
    credential === "api-key" ? undefined : savedLoginAddress(input, env);

  let chosen: ResolvedDeployment;
  if (managed.state === "valid" && managed.lock) {
    chosen = at(managed.deployment, "managed");
    for (const other of [explicit, named]) {
      if (other && !sameServer(other, chosen)) {
        throw lockRefusal(chosen, managed.path, other);
      }
    }
  } else if (explicit) {
    chosen = at(explicit, "flag");
  } else if (fromEnv) {
    chosen = at(fromEnv, "env");
  } else if (saved) {
    chosen = at(saved, "oauth");
  } else if (managed.state === "valid") {
    chosen = at(managed.deployment, "managed-default");
  } else {
    chosen = at(MCPJAM_CLOUD, "default");
  }

  if (credential === "oauth" && saved && !sameServer(saved, chosen)) {
    throw loginMismatch(saved, chosen);
  }
  return chosen;
}
