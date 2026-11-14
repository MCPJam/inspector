import type { EvalRunContext } from "./eval-run-start.js";
import { resolveDeployment } from "./deployment/resolve.js";
import { SdkError } from "./errors.js";
import type { McpjamAuthContext } from "./mcpjam-model-lease.js";
import {
  assertSecureCallbackOrigin,
  resolveMcpjamProject,
} from "./mcpjam-model-lease.js";
import {
  getAuthFilePath,
  getOAuthAccessToken,
  readStoredAuth,
} from "./platform-auth.js";

export interface EvalIdentityOptions {
  apiKey?: string;
  mcpjamAuth?: McpjamAuthContext;
  /** Recorded client surface; defaults to SDK. */
  surface?: "sdk" | "cli" | "vitest";
  clientVersion?: string;
  /** @internal Scoped online start and connection, never serialized in reports. */
  __evalRunContext?: EvalRunContext;
}

export const EVAL_LOGIN_REQUIRED =
  "Eval runs require an MCPJam login or API key. Run `mcpjam cloud login`, or set MCPJAM_API_KEY to an sk_ key. Ask an organization admin if you need a key.";
export class EvalRunStartError extends SdkError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, code, { cause });
    this.name = "EvalRunStartError";
  }
}

export async function resolveEvalRunCredential(
  options: EvalIdentityOptions & {
    baseUrl?: string;
    project?: string;
  }
) {
  if (options.apiKey !== undefined && options.mcpjamAuth !== undefined) {
    throw new EvalRunStartError(
      "Choose one MCPJam credential: apiKey or mcpjamAuth.",
      "CREDENTIALS_AMBIGUOUS"
    );
  }
  const key =
    options.apiKey ??
    (options.mcpjamAuth ? undefined : process.env.MCPJAM_API_KEY?.trim() || undefined);
  let auth: McpjamAuthContext;
  // Set only when the saved login is the credential in use.
  let savedLoginPath: string | undefined;
  if (key !== undefined) {
    if (!key.trim())
      throw new EvalRunStartError(EVAL_LOGIN_REQUIRED, "CREDENTIALS_MISSING");
    if (!key.trim().startsWith("sk_")) {
      throw new EvalRunStartError(
        "This MCPJam API key is invalid or retired. Create an sk_ key in Settings > API keys.",
        "UNAUTHORIZED"
      );
    }
    auth = { getAuth: async () => key.trim() };
  } else if (options.mcpjamAuth) {
    auth = options.mcpjamAuth;
  } else {
    const authFilePath = getAuthFilePath();
    if (!readStoredAuth(authFilePath))
      throw new EvalRunStartError(EVAL_LOGIN_REQUIRED, "CREDENTIALS_MISSING");
    savedLoginPath = authFilePath;
    auth = {
      getAuth: async () => {
        try {
          return await getOAuthAccessToken({ authFilePath });
        } catch (error) {
          if (error instanceof Error && error.message.includes("Could not reach")) {
            throw new TypeError("Could not refresh the MCPJam login", { cause: error });
          }
          throw new EvalRunStartError(
            "Your MCPJam login could not be refreshed. Run `mcpjam cloud login` again.",
            "SESSION_REVOKED",
            error
          );
        }
      },
    };
  }
  // A caller's own `mcpjamAuth` counts as a key: the saved login is not in use.
  const { baseUrl } = resolveDeployment(
    savedLoginPath
      ? {
          baseUrl: options.baseUrl,
          credential: "oauth",
          authFilePath: savedLoginPath,
        }
      : { baseUrl: options.baseUrl, credential: "api-key" }
  );
  if (key === undefined) assertSecureCallbackOrigin(baseUrl);
  return {
    auth,
    baseUrl,
    project: resolveMcpjamProject(options.project),
  };
}
