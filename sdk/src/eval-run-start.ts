import { randomUUID } from "node:crypto";
import { V1_ERROR_STATUS } from "./public-api/index.js";
import { z } from "zod";
import {
  reportingRequest,
  ReportingHttpError,
} from "./eval-reporting-transport.js";
import {
  EvalRunStartError,
  resolveEvalRunCredential,
  type EvalIdentityOptions,
} from "./eval-run-credentials.js";
import type { MCPJamReportingConfig } from "./eval-reporting-types.js";
import type { HostExecutor } from "./HostExecutor.js";
import { readSdkVersion } from "./sdk-version.js";

export { EvalRunStartError } from "./eval-run-credentials.js";
export type { EvalIdentityOptions } from "./eval-run-credentials.js";
const receiptSchema = z.object({
  ok: z.literal(true),
  runStartId: z.string().uuid(),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
});
export type EvalRunStartReceipt = z.infer<typeof receiptSchema>;
const refusalMessages: Record<string, string> = {
  UNAUTHORIZED:
    "Your MCPJam credential is invalid or revoked. Create a new sk_ key or run `mcpjam cloud login` again.",
  EXPIRED_KEY:
    "Your MCPJam API key has expired. Create a new key in Settings > API keys.",
  ORPHANED_KEY:
    "Your MCPJam API key no longer belongs to an active account. Ask an organization admin for a new key.",
  SESSION_REVOKED:
    "Your MCPJam login has been revoked. Run `mcpjam cloud login` again.",
  FORBIDDEN:
    "Your MCPJam account or key cannot access this project. Choose a project in your organization.",
  NOT_FOUND:
    "The MCPJam project was not found. Check your project selection and try again.",
  CONFLICT:
    "This eval start ID was reused with different settings. Start a new run.",
  RATE_LIMITED:
    "MCPJam is receiving too many requests. Wait a moment and run the eval again.",
};

export async function startEvalRun(
  options: EvalIdentityOptions & {
    mcpjam?: MCPJamReportingConfig;
    plannedIterations: number;
    providers?: string[];
    usedClientProfile?: boolean | "unknown";
    signal?: AbortSignal;
  }
): Promise<EvalRunStartReceipt> {
  const credential = await resolveEvalRunCredential({
    ...options,
    apiKey: options.apiKey ?? options.mcpjam?.apiKey,
    baseUrl: options.mcpjam?.baseUrl,
    project: options.mcpjam?.project,
  });
  const runStartId = randomUUID();
  const body = {
    runStartId,
    surface: options.surface ?? "sdk",
    clientVersion: options.clientVersion ?? readSdkVersion(),
    providers: [...new Set(options.providers ?? [])].sort(),
    usedClientProfile: options.usedClientProfile ?? "unknown",
    plannedIterations: options.plannedIterations,
  };
  const url = `${credential.baseUrl}/api/v1/projects/${encodeURIComponent(
    credential.project
  )}/eval-ingest/start-run`;
  const deadlineAt = Date.now() + 10_000;
  try {
    return await reportingRequest(
      {
        timeoutMs: 3000,
        operationTimeoutMs: 10_000,
        deadlineAt,
        retryDelaysMs: [100, 300],
        maxResponseBytes: 16_384,
        signal: options.signal,
      },
      url,
      { method: "POST", body: JSON.stringify(body) },
      (value) => {
        const receipt = receiptSchema.parse(value);
        if (receipt.runStartId !== runStartId)
          throw new EvalRunStartError(
            "MCPJam returned a different eval start. Try a new run.",
            "INVALID_RESPONSE"
          );
        return receipt;
      },
      (error) => error.status >= 500 ||
        (error.status === 429 && (error.retryAfterMs ?? 0) < deadlineAt - Date.now()),
      undefined,
      async () => {
        const headers = new Headers(credential.auth.headers);
        headers.set("Content-Type", "application/json");
        const bearer = await credential.auth.getAuth();
        if (!bearer.trim())
          throw new EvalRunStartError(
            "Your MCPJam login is missing. Run `mcpjam cloud login` again.",
            "CREDENTIALS_MISSING"
          );
        headers.set("Authorization", `Bearer ${bearer}`);
        return { headers };
      }
    );
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof EvalRunStartError) throw error;
    if (error instanceof ReportingHttpError && error.status < 500) {
      const details = error.body.details;
      const detailCode = details && typeof details === "object"
        ? "reason" in details && typeof details.reason === "string" ? details.reason
          : "code" in details && typeof details.code === "string" ? details.code : undefined
        : undefined;
      const code = detailCode ?? (typeof error.body.code === "string" ? error.body.code
        : Object.entries(V1_ERROR_STATUS).find(([, status]) => status === error.status)?.[0] ?? "INTERNAL_ERROR");
      throw new EvalRunStartError(
        refusalMessages[code] ??
          "MCPJam refused to start the eval. Check your credentials and try again.",
        code,
        error
      );
    }
    throw new EvalRunStartError(
      "Could not reach MCPJam to start the eval. Check your connection and try again. Nothing was run.",
      "PLATFORM_UNAVAILABLE",
      error
    );
  }
}

export function executorProviders(executor: HostExecutor): string[] {
  if (
    !("getParsedProvider" in executor) ||
    typeof executor.getParsedProvider !== "function"
  )
    return [];
  const provider: unknown = executor.getParsedProvider();
  return typeof provider === "string" && /^[a-z0-9_-]{1,64}$/.test(provider)
    ? [provider]
    : [];
}
