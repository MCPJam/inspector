/**
 * Cloud audience line and credential preflight.
 *
 * Machine-readable results stay on stdout. Context (who you are, which
 * project, which deployment) goes to stderr and is omitted under `--quiet`.
 * Preflight fails with the same login guidance `getOAuthAccessToken` uses, so
 * a missing credential does not wait for the first HTTP call.
 */
import { getAuthFilePath, readStoredAuth } from "./auth-store.js";
import {
  describeCloudCredential,
  type DescribeCloudCredentialDependencies,
} from "./credential-describe.js";
import {
  describeProjectScope,
  type CloudScope,
} from "./cloud-scope.js";
import {
  LEGACY_KEY_REMEDY,
  MISSING_CLOUD_CREDENTIAL_MESSAGE,
} from "./platform-auth.js";
import { operationalError, usageError } from "./output.js";

export { MISSING_CLOUD_CREDENTIAL_MESSAGE };

/** Credential flags only — kept local so this module does not import `platform-command`. */
export type CloudCredentialOptions = {
  apiKey?: string;
  apiUrl?: string;
};

/**
 * Cloud commands that must not print the audience line. Inner polls, whoami,
 * and link write pass `announce` as false at the call site rather than living
 * here.
 */
export const CLOUD_AUDIENCE_EXEMPTIONS = [
  "login",
  "logout",
  "whoami",
  "link",
  "status",
] as const;

export type CloudAudienceLineInput = {
  scope: CloudScope;
  options: CloudCredentialOptions;
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
};

function identityLabel(
  options: CloudCredentialOptions,
  deps: DescribeCloudCredentialDependencies
): string {
  const { credential } = describeCloudCredential(options, deps);
  if (credential.kind === "api-key" && credential.redactedKey) {
    return credential.redactedKey;
  }
  if (credential.kind === "oauth") {
    const authFilePath =
      deps.authFilePath ?? getAuthFilePath({ env: deps.env ?? process.env });
    const email = readStoredAuth(authFilePath)?.email?.trim();
    if (email) return email;
    return "oauth";
  }
  return "unauthenticated";
}

function scopeLabel(scope: CloudScope): string {
  switch (scope.kind) {
    case "account":
      return "account";
    case "organization":
      return scope.organization
        ? `organization ${scope.organization}`
        : "organization";
    case "all-projects":
      return "all projects";
    case "project":
      return `project: ${describeProjectScope(scope)}`;
  }
}

/** Pure: the audience line as printed to stderr. */
export function formatCloudAudienceLine(input: CloudAudienceLineInput): string {
  const deps = {
    env: input.env ?? process.env,
    authFilePath: input.authFilePath,
  };
  const { deployment } = describeCloudCredential(input.options, deps);
  return `Using MCPJam Cloud as ${identityLabel(input.options, deps)} · ${scopeLabel(input.scope)} · ${deployment.apiUrl}`;
}

export function preflightCloudCredentials(
  options: CloudCredentialOptions,
  deps: DescribeCloudCredentialDependencies = {}
): void {
  const { credential, deployment } = describeCloudCredential(options, deps);
  if (credential.valid === false) {
    throw usageError(credential.error ?? LEGACY_KEY_REMEDY);
  }
  if (!deployment.valid) {
    throw usageError(deployment.error ?? "Invalid API URL.");
  }
  if (credential.source === "missing") {
    const envKey = (deps.env ?? process.env).MCPJAM_API_KEY?.trim();
    if (envKey?.startsWith("mcpjam_")) {
      throw operationalError(
        `${MISSING_CLOUD_CREDENTIAL_MESSAGE} Ignoring legacy mcpjam_ key in MCPJAM_API_KEY for this command. ${LEGACY_KEY_REMEDY}`
      );
    }
    throw operationalError(MISSING_CLOUD_CREDENTIAL_MESSAGE);
  }
}

export function announceCloudContext(
  input: CloudAudienceLineInput & { quiet?: boolean; announce?: boolean }
): void {
  if (input.announce === false || input.quiet === true) return;
  process.stderr.write(`${formatCloudAudienceLine(input)}\n`);
}
