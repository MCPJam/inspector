/**
 * Offline description of how this process would authenticate to MCPJam Cloud
 * and which deployment it would talk to.
 *
 * Mirrors `resolvePlatformCredential` / `buildPlatformClient` precedence
 * without calling `getAuth()` or the network. `cloud status` is the consumer.
 */
import { DEFAULT_PLATFORM_API_BASE_URL } from "@mcpjam/sdk/platform";
import { getAuthFilePath, readStoredAuth } from "./auth-store.js";
import { LEGACY_KEY_REMEDY } from "./platform-auth.js";
import { validateApiUrl } from "./platform-client.js";
import { usageError } from "./output.js";

const LEGACY_API_KEY_PREFIX = "mcpjam_";

export type CloudCredentialSource = "flag" | "env" | "oauth" | "missing";
export type CloudDeploymentSource = "flag" | "env" | "oauth" | "default";

export type CloudCredentialDescription = {
  source: CloudCredentialSource;
  kind: "api-key" | "oauth" | "none";
  redactedKey?: string;
  envShadowsOauth: boolean;
  storedOauthPresent: boolean;
};

export type CloudDeploymentDescription = {
  apiUrl: string;
  source: CloudDeploymentSource;
};

export type DescribeCloudCredentialDependencies = {
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
};

export function redactCloudApiKey(key: string): string {
  const last4 = key.slice(-4);
  return `sk_…${last4}`;
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function isUsableSkKey(value: string): boolean {
  return !value.startsWith(LEGACY_API_KEY_PREFIX);
}

export function describeCloudCredential(
  options: { apiKey?: string; apiUrl?: string },
  deps: DescribeCloudCredentialDependencies = {}
): {
  credential: CloudCredentialDescription;
  deployment: CloudDeploymentDescription;
} {
  const env = deps.env ?? process.env;
  const authFilePath = deps.authFilePath ?? getAuthFilePath({ env });
  const stored = readStoredAuth(authFilePath);
  const storedOauthPresent = stored !== null;

  const flagKey = trimmed(options.apiKey);
  const envKey = trimmed(env.MCPJAM_API_KEY);
  const usableEnvKey = envKey && isUsableSkKey(envKey) ? envKey : undefined;

  if (flagKey && !isUsableSkKey(flagKey)) {
    throw usageError(LEGACY_KEY_REMEDY);
  }

  let credential: CloudCredentialDescription;
  if (flagKey) {
    credential = {
      source: "flag",
      kind: "api-key",
      redactedKey: redactCloudApiKey(flagKey),
      envShadowsOauth: false,
      storedOauthPresent,
    };
  } else if (usableEnvKey) {
    credential = {
      source: "env",
      kind: "api-key",
      redactedKey: redactCloudApiKey(usableEnvKey),
      envShadowsOauth: storedOauthPresent,
      storedOauthPresent,
    };
  } else if (stored) {
    credential = {
      source: "oauth",
      kind: "oauth",
      envShadowsOauth: false,
      storedOauthPresent,
    };
  } else {
    credential = {
      source: "missing",
      kind: "none",
      envShadowsOauth: false,
      storedOauthPresent,
    };
  }

  const flagUrl = trimmed(options.apiUrl);
  const envUrl = trimmed(env.MCPJAM_API_URL);
  let deployment: CloudDeploymentDescription;
  if (flagUrl) {
    deployment = { apiUrl: validateApiUrl(flagUrl, "--api-url"), source: "flag" };
  } else if (envUrl) {
    deployment = {
      apiUrl: validateApiUrl(envUrl, "MCPJAM_API_URL"),
      source: "env",
    };
  } else if (stored?.apiUrl) {
    deployment = { apiUrl: stored.apiUrl, source: "oauth" };
  } else {
    deployment = {
      apiUrl: DEFAULT_PLATFORM_API_BASE_URL,
      source: "default",
    };
  }

  return { credential, deployment };
}
