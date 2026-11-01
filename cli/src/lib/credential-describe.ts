/**
 * Offline description of how this process would authenticate to MCPJam Cloud
 * and which deployment it would talk to.
 *
 * Mirrors `resolvePlatformCredential` precedence without calling `getAuth()`
 * or the network, and asks the same resolver `buildPlatformClient` uses for
 * the deployment. `cloud status` is the consumer, so a refused deployment is
 * reported in-band instead of thrown.
 */
import {
  isMcpjamDeploymentError,
  resolveDeployment,
  type DeploymentSource,
} from "@mcpjam/sdk/internal/deployment";
import { getAuthFilePath, readStoredAuth } from "./auth-store.js";
import { inspectExplicitApiKey } from "./platform-auth.js";

const LEGACY_API_KEY_PREFIX = "mcpjam_";

export type CloudCredentialSource = "flag" | "env" | "oauth" | "missing";
export type CloudDeploymentSource = DeploymentSource;

const DEPLOYMENT_SOURCE_DESCRIPTIONS: Record<CloudDeploymentSource, string> = {
  managed: "set by your organization (locked)",
  "managed-default": "set by your organization",
  flag: "set by --api-url",
  env: "set by MCPJAM_API_URL or MCPJAM_BASE_URL",
  oauth: "the server of your saved login",
  default: "MCPJam Cloud, the default",
};

/** Where the server came from, as `cloud status` and the audience line say it. */
export function describeDeploymentSource(
  deployment: Pick<CloudDeploymentDescription, "source" | "valid">
): string {
  // An invalid settings file sets nothing: its intended policy is unknown.
  if (deployment.source === "managed" && !deployment.valid) {
    return "your organization's settings file, which is invalid";
  }
  return DEPLOYMENT_SOURCE_DESCRIPTIONS[deployment.source];
}

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
    const inspected = inspectExplicitApiKey(flagKey, {
      apiUrl: options.apiUrl,
      env,
    });
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

  return {
    credential,
    deployment: describeDeployment(options, credential, {
      env,
      authFilePath,
    }),
  };
}

function describeDeployment(
  options: { apiUrl?: string },
  credential: CloudCredentialDescription,
  deps: { env: NodeJS.ProcessEnv; authFilePath: string }
): CloudDeploymentDescription {
  try {
    const resolved = resolveDeployment({
      apiUrl: options.apiUrl,
      credential: credential.kind === "api-key" ? "api-key" : "oauth",
      ...deps,
    });
    return { apiUrl: resolved.apiUrl, source: resolved.source, valid: true };
  } catch (error) {
    if (!isMcpjamDeploymentError(error)) throw error;
    // An invalid IT settings file names no server; its error names the file.
    return {
      apiUrl: error.apiUrl ?? "",
      source: error.source ?? "default",
      valid: false,
      error: error.message,
    };
  }
}
