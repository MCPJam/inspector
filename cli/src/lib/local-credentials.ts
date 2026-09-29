import {
  SuiteFileRunError,
  type McpjamInferenceConnection,
  type SuiteFileInferenceOptions,
} from "@mcpjam/sdk";
import { isPlatformApiError, resolveProject } from "@mcpjam/sdk/platform";
import { resolveCloudProjectArgs } from "./cloud-scope.js";
import { CliError, usageError } from "./output.js";
import { resolvePlatformCredential } from "./platform-auth.js";
import {
  buildPlatformClient,
  resolvePlatformExtraHeaders,
} from "./platform-client.js";

/**
 * Credentials for `mcpjam test`: explicit provider keys for BYOK inference,
 * and a LAZY resolver for MCPJam-hosted inference.
 *
 * The SDK runner never reads the environment; this module reads the standard
 * provider variables explicitly, once, and hands the SDK plain values. The
 * platform resolver runs only when a selected case actually needs the MCPJam
 * rail, so a BYOK-only run never touches the login store, never lists
 * projects and never sends a platform request.
 */

/** Standard provider key variables, per SDK provider id. First set wins. */
export const PROVIDER_KEY_ENV_VARS: Readonly<
  Record<string, readonly string[]>
> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
};

export function readProviderKeys(
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [provider, names] of Object.entries(PROVIDER_KEY_ENV_VARS)) {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) {
        keys[provider] = value;
        break;
      }
    }
  }
  return keys;
}

/**
 * `value` without its trailing slashes. `replace(/\/+$/, "")` is the shorter
 * spelling, but CodeQL rates it `js/polynomial-redos` (high): on input shaped
 * like `"a" + "/".repeat(n) + "b"` the engine retries `\/+$` from every
 * position. Same behaviour, linear.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function baseUrlFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  normalize: (url: URL) => string = (url) => trimTrailingSlashes(url.href)
): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(
      `${name} must be a URL (received ${JSON.stringify(raw)}).`
    );
  }
  return normalize(url);
}

/**
 * Provider base URLs from their standard variables — a gateway, a proxy, a
 * local model server. `OPENAI_BASE_URL` includes `/v1` by convention;
 * `ANTHROPIC_BASE_URL` does not (the official SDKs append it), so it is
 * normalized to the `/v1` form the provider factory expects.
 */
export function readProviderBaseUrls(
  env: NodeJS.ProcessEnv
): NonNullable<SuiteFileInferenceOptions["baseUrls"]> {
  const openai = baseUrlFromEnv(env, "OPENAI_BASE_URL");
  const anthropic = baseUrlFromEnv(env, "ANTHROPIC_BASE_URL", (url) => {
    const trimmed = trimTrailingSlashes(url.href);
    return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  });
  const ollama = baseUrlFromEnv(env, "OLLAMA_BASE_URL");
  return {
    ...(openai ? { openai } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(ollama ? { ollama } : {}),
  };
}

/**
 * The MCPJam app base for an API base URL — `/api/v1` stripped EXACTLY once,
 * because the lease client appends it again. A deployment under a path prefix
 * keeps its prefix.
 */
export function appBaseFromApiBase(apiBaseUrl: string): string {
  const trimmed = trimTrailingSlashes(apiBaseUrl);
  return trimmed.replace(/\/api\/v1$/, "");
}

export type McpjamResolverOptions = {
  apiKey?: string;
  apiUrl?: string;
  apiHeader?: string[];
  project?: string;
};

function refusalFromCliError(error: CliError): SuiteFileRunError {
  if (error.exitCode === 2) {
    return new SuiteFileRunError({
      code: "OPTIONS_INVALID",
      phase: "setup",
      category: "usage",
      message: error.message,
    });
  }
  return new SuiteFileRunError({
    code: "CREDENTIALS_MISSING",
    phase: "setup",
    category: "credentials",
    message: error.message,
  });
}

/**
 * Build the lazy MCPJam connection resolver, using the CLI's existing
 * credential precedence (`--api-key` > `MCPJAM_API_KEY` > `mcpjam cloud
 * login`) and project precedence (`--project` > env > `cloud link` > the most
 * recently updated project), resolved to a CONCRETE project id.
 */
export function createMcpjamConnectionResolver(
  options: McpjamResolverOptions,
  deps: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    authFilePath?: string;
    fetchFn?: typeof fetch;
    warn?: (message: string) => void;
  }
): () => Promise<McpjamInferenceConnection> {
  return async () => {
    const warned = new Set<string>();
    const warn = (message: string) => {
      if (warned.has(message)) return;
      warned.add(message);
      (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        message
      );
    };
    const credentialDeps = {
      env: deps.env,
      warn,
      ...(deps.authFilePath ? { authFilePath: deps.authFilePath } : {}),
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    };
    let built: ReturnType<typeof buildPlatformClient>;
    let credential: ReturnType<typeof resolvePlatformCredential>;
    let headers: Record<string, string> | undefined;
    let selector: string | undefined;
    try {
      built = buildPlatformClient(
        {
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
          ...(options.apiHeader ? { apiHeader: options.apiHeader } : {}),
          timeoutMs: deps.timeoutMs,
        },
        credentialDeps
      );
      credential = resolvePlatformCredential(
        options.apiKey ? { apiKey: options.apiKey } : {},
        credentialDeps
      );
      headers = resolvePlatformExtraHeaders(
        options.apiHeader ? { apiHeader: options.apiHeader } : {},
        deps.env
      );
      selector = resolveCloudProjectArgs(
        options.project ? { project: options.project } : {}
      ).project;
    } catch (error) {
      if (error instanceof CliError) throw refusalFromCliError(error);
      throw error;
    }

    let projects;
    try {
      projects = await built.client.listProjects(
        {},
        deps.signal ? { signal: deps.signal } : {}
      );
    } catch (error) {
      if (error instanceof CliError) throw refusalFromCliError(error);
      if (isPlatformApiError(error)) {
        const auth =
          error.status === 401 ||
          error.status === 403 ||
          ["UNAUTHORIZED", "FORBIDDEN", "OAUTH_REQUIRED"].includes(error.code);
        throw new SuiteFileRunError({
          code: auth ? "CREDENTIALS_REJECTED" : "PLATFORM_UNAVAILABLE",
          phase: "setup",
          category: auth ? "credentials" : "setup",
          message: `MCPJam rejected the request to resolve a project: ${error.message}`,
        });
      }
      throw new SuiteFileRunError({
        code: "PLATFORM_UNAVAILABLE",
        phase: "setup",
        category: "setup",
        message: `Could not reach MCPJam to resolve a project: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    const resolution = resolveProject(projects.items, selector);
    if (!resolution.ok) {
      throw new SuiteFileRunError({
        code: "OPTIONS_INVALID",
        phase: "setup",
        category: "usage",
        message: resolution.message,
      });
    }
    return {
      baseUrl: appBaseFromApiBase(built.baseUrl),
      projectId: resolution.project.id,
      getAuth: () => credential.getAuth(),
      ...(headers ? { headers } : {}),
    };
  };
}
