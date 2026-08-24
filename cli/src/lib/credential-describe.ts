/**
 * Offline description of how this process would authenticate to MCPJam Cloud
 * and which deployment it would talk to.
 *
 * Mirrors `resolvePlatformCredential` / `buildPlatformClient` precedence
 * without calling `getAuth()` or the network. `cloud status` is the consumer.
 */
import { DEFAULT_PLATFORM_API_BASE_URL } from "@mcpjam/sdk/platform";
import { getAuthFilePath, readStoredAuth } from "./auth-store.js";
import { inspectExplicitApiKey } from "./platform-auth.js";
import { inspectApiUrl } from "./platform-client.js";

const LEGACY_API_KEY_PREFIX = "mcpjam_";

export type CloudCredentialSource = "flag" | "env" | "oauth" | "missing";
export type CloudDeploymentSource = "flag" | "env" | "oauth" | "default";

export type CloudCredentialDescription = {
  source: CloudCredentialSource;
  kind: "api-key" | "oauth" | "none";
  /**
   * `true` when a usable credential is configured, `false` when an explicit
   * credential is invalid (legacy `--api-key`), `null` when none is configured.
   */
  valid: boolean | null;
  error?: string;
  redactedKey?: string;
  envShadowsOauth: boolean;
  storedOauthPresent: boolean;
};

export type CloudDeploymentDescription = {
  apiUrl: string;
  source: CloudDeploymentSource;
  valid: boolean;
  error?: string;
};

export type DescribeCloudCredentialDependencies = {
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
};

export function redactCloudApiKey(key: string): string {
  const separator = key.indexOf("_");
  const prefix = separator > 0 ? key.slice(0, separator + 1) : "";
  const secret = key.slice(prefix.length);
  if (secret.length < 8) {
    return `${prefix}…`;
  }
  return `${prefix}…${secret.slice(-4)}`;
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

  let credential: CloudCredentialDescription;
  if (flagKey) {
    const inspected = inspectExplicitApiKey(flagKey);
    credential = {
      source: "flag",
      kind: "api-key",
      valid: inspected.ok,
      ...(inspected.ok ? {} : { error: inspected.error }),
      redactedKey: redactCloudApiKey(flagKey),
      envShadowsOauth: false,
      storedOauthPresent,
    };
  } else if (usableEnvKey) {
    credential = {
      source: "env",
      kind: "api-key",
      valid: true,
      redactedKey: redactCloudApiKey(usableEnvKey),
      envShadowsOauth: storedOauthPresent,
      storedOauthPresent,
    };
  } else if (stored) {
    credential = {
      source: "oauth",
      kind: "oauth",
      valid: true,
      envShadowsOauth: false,
      storedOauthPresent,
    };
  } else {
    credential = {
      source: "missing",
      kind: "none",
      valid: null,
      envShadowsOauth: false,
      storedOauthPresent,
    };
  }

  const flagUrl = trimmed(options.apiUrl);
  const envUrl = trimmed(env.MCPJAM_API_URL);
  let deployment: CloudDeploymentDescription;
  if (flagUrl) {
    const inspected = inspectApiUrl(flagUrl, "--api-url");
    deployment = {
      apiUrl: inspected.ok ? inspected.apiUrl : flagUrl,
      source: "flag",
      valid: inspected.ok,
      ...(inspected.ok ? {} : { error: inspected.error }),
    };
  } else if (envUrl) {
    const inspected = inspectApiUrl(envUrl, "MCPJAM_API_URL");
    deployment = {
      apiUrl: inspected.ok ? inspected.apiUrl : envUrl,
      source: "env",
      valid: inspected.ok,
      ...(inspected.ok ? {} : { error: inspected.error }),
    };
  } else if (stored?.apiUrl) {
    deployment = { apiUrl: stored.apiUrl, source: "oauth", valid: true };
  } else {
    deployment = {
      apiUrl: DEFAULT_PLATFORM_API_BASE_URL,
      source: "default",
      valid: true,
    };
  }

  return { credential, deployment };
}
