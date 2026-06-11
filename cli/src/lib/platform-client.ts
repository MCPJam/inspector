import {
  DEFAULT_PLATFORM_API_BASE_URL,
  isPlatformApiError,
  PlatformApiClient,
} from "@mcpjam/sdk/platform";
import packageJson from "../../package.json" with { type: "json" };
import { CliError, cliError } from "./output.js";
import {
  DEFAULT_PLATFORM_ORIGIN,
  resolvePlatformCredential,
  type ResolveCredentialDependencies,
} from "./platform-auth.js";

export interface PlatformClientOptions {
  apiKey?: string;
  apiUrl?: string;
  timeoutMs?: number;
}

export function resolvePlatformBaseUrl(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    options.apiUrl?.trim() ||
    env.MCPJAM_API_URL?.trim() ||
    DEFAULT_PLATFORM_API_BASE_URL
  );
}

/** Origin for the hosted CLI auth routes, derived from the API base URL. */
export function resolvePlatformOrigin(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return new URL(resolvePlatformBaseUrl(options, env)).origin;
  } catch {
    return DEFAULT_PLATFORM_ORIGIN;
  }
}

export function buildPlatformClient(
  options: PlatformClientOptions,
  deps: ResolveCredentialDependencies = {},
): { client: PlatformApiClient; credentialKind: "api-key" | "oauth" } {
  const credential = resolvePlatformCredential(options, deps);
  const client = new PlatformApiClient({
    baseUrl: resolvePlatformBaseUrl(options, deps.env ?? process.env),
    getAuth: credential.getAuth,
    ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    userAgent: `mcpjam-cli/${packageJson.version}`,
  });
  return { client, credentialKind: credential.kind };
}

/**
 * Map platform API failures onto CLI errors: the stable wire code becomes
 * the CLI error code (exit 1), with login guidance on auth failures.
 */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (isPlatformApiError(error)) {
    const message =
      error.code === "UNAUTHORIZED"
        ? `${error.message} Run \`mcpjam login\` or pass a valid sk_ API key.`
        : error.message;
    return cliError(error.code, message, 1, error.details);
  }
  return cliError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
  );
}
