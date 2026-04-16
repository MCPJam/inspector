/**
 * Centralized env var access for Soundcheck.
 *
 * Keeping every secret read in one place means the secrets rotation runbook
 * in `soundcheck/README.md` maps 1:1 to this file.
 */

type EnvKey =
  | "RAILWAY_API_TOKEN"
  | "CONVEX_DEPLOY_KEY_STAGING"
  | "CONVEX_DEPLOY_KEY_PROD"
  | "GITHUB_PAT"
  | "WORKOS_API_KEY"
  | "WORKOS_CLIENT_ID"
  | "WORKOS_COOKIE_PASSWORD"
  | "MCPJAM_NONPROD_LOCKDOWN"
  | "MCPJAM_EMPLOYEE_EMAIL_DOMAINS";

export function env(key: EnvKey): string | undefined {
  return process.env[key];
}

export function requireEnv(key: EnvKey): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}
