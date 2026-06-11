import {
  DEFAULT_PLATFORM_API_BASE_URL,
  isPlatformApiError,
  PlatformApiClient,
} from "@mcpjam/sdk/platform";
import packageJson from "../../package.json" with { type: "json" };
import { getAuthFilePath, readStoredAuth } from "./auth-store.js";
import { CliError, cliError, usageError } from "./output.js";
import {
  resolvePlatformCredential,
  type ResolveCredentialDependencies,
} from "./platform-auth.js";

export interface PlatformClientOptions {
  apiKey?: string;
  apiUrl?: string;
}

/**
 * An explicitly supplied API URL (flag or env) that does not parse must
 * hard-error: silently falling back to prod would run a login or send a
 * token somewhere the user did not ask for.
 */
function validateApiUrl(value: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError(
      `Invalid ${source} value "${value}". Expected a full URL like ${DEFAULT_PLATFORM_API_BASE_URL}.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(
      `Invalid ${source} value "${value}". Expected an http(s) URL like ${DEFAULT_PLATFORM_API_BASE_URL}.`,
    );
  }
  return value;
}

/** The API URL the user explicitly asked for, if any (flag wins over env). */
function resolveExplicitApiUrl(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const flagUrl = options.apiUrl?.trim();
  if (flagUrl) {
    return validateApiUrl(flagUrl, "--api-url");
  }
  const envUrl = env.MCPJAM_API_URL?.trim();
  if (envUrl) {
    return validateApiUrl(envUrl, "MCPJAM_API_URL");
  }
  return undefined;
}

export function resolvePlatformBaseUrl(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveExplicitApiUrl(options, env) ?? DEFAULT_PLATFORM_API_BASE_URL;
}

/** Origin for the hosted CLI auth routes, derived from the API base URL. */
export function resolvePlatformOrigin(
  options: Pick<PlatformClientOptions, "apiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return new URL(resolvePlatformBaseUrl(options, env)).origin;
}

export function buildPlatformClient(
  options: PlatformClientOptions,
  deps: ResolveCredentialDependencies = {},
): { client: PlatformApiClient; credentialKind: "api-key" | "oauth" } {
  const env = deps.env ?? process.env;
  const credential = resolvePlatformCredential(options, deps);

  // When the stored OAuth login is the credential, its tokens belong to the
  // deployment it was created against — default to that deployment's API URL
  // so a staging login never silently sends its token to prod.
  let baseUrl = resolveExplicitApiUrl(options, env);
  if (!baseUrl && credential.kind === "oauth") {
    const stored = readStoredAuth(deps.authFilePath ?? getAuthFilePath({ env }));
    baseUrl = stored?.apiUrl;
  }

  const client = new PlatformApiClient({
    baseUrl: baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL,
    getAuth: credential.getAuth,
    ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}),
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
