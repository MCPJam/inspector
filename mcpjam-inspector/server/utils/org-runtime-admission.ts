/**
 * The runtime resolver's request to `/stream/org/resolve`, its 60 s cache,
 * and the per-attempt admission a local-runtime model asks before every
 * provider call (`admitLocalOrgAttempt`). `resolveOrgProviderRuntime` in
 * `org-model-config.ts` answers from the same cache.
 */
import { createHash } from "node:crypto";
import { logger } from "./logger.js";
import { selectionKey, type ModelSelection } from "@mcpjam/sdk";
import type { OrgProviderResolvedConfig } from "@mcpjam/sdk/model-factory";
import {
  verifyGithubCredentialAccess,
  githubExecutionPolicy,
} from "../services/github-checks/credential-policy.js";
import { HOSTED_MODE } from "../config.js";
import {
  isAiConfigurationRefusalCode,
  isOrgKeyPolicyRefusalCode,
} from "../../shared/ai-execution-refusal.js";
import { backendFailureText } from "./backend-failure-text.js";
import {
  ModelResolutionRefusalError,
  type ModelRefusalCode,
} from "./model-resolution-local.js";
import type { ModelWorkload } from "./model-workload.js";
import type {
  OrgProviderRuntime,
  ResolveOrgModelConfigAuth,
  ResolveOrgProviderRuntimeTarget,
} from "./org-model-config.js";
import {
  RESOLVE_TIMEOUT_MS,
  assertSafeHostedOutboundUrl,
  formatTargetForCache,
  normalizeAuthHeader,
  normalizeServerIds,
} from "./org-resolve-request.js";

/**
 * What `/stream/org/resolve` was asked. A local-runtime model keeps it so each
 * provider attempt can ask again (`admitLocalOrgAttempt`).
 */
export type LocalOrgAttemptRequest = {
  target: ResolveOrgProviderRuntimeTarget;
  providerKey: string;
  model: string;
  auth?: ResolveOrgModelConfigAuth;
  options?: { modelSelection?: ModelSelection; modelWorkload?: ModelWorkload };
};

// The cache saves a round trip when a turn or an eval case starts: where the
// provider runs, and the config to build its model from. It is never
// permission to call the provider. On the local runtime each attempt (every
// step, every retry) asks the backend again through `admitLocalOrgAttempt`,
// so a cached `local` answer cannot run anything after an admin turns on "Use
// your keys for all AI features" or turns the connection off. The backend
// never answers `local` while the policy is on, so in practice only orgs
// without the policy get `local` answers from here.
const RUNTIME_CACHE_TTL_MS = 60_000;
const RUNTIME_CACHE_MAX_ENTRIES = 1_000;
export const runtimeResolveCache = new Map<
  string,
  { result: OrgProviderRuntime; expiresAt: number }
>();

export function pruneRuntimeResolveCache(now: number): void {
  // Always evict expired entries — they may hold decrypted API keys.
  for (const [key, entry] of runtimeResolveCache) {
    if (entry.expiresAt <= now) runtimeResolveCache.delete(key);
  }
  // Then cap size by removing oldest entries if still over limit.
  if (runtimeResolveCache.size > RUNTIME_CACHE_MAX_ENTRIES) {
    const overflow = runtimeResolveCache.size - RUNTIME_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of runtimeResolveCache.keys()) {
      if (removed >= overflow) break;
      runtimeResolveCache.delete(key);
      removed++;
    }
  }
}

export function buildRuntimeCacheKey(
  target: ResolveOrgProviderRuntimeTarget,
  providerKey: string,
  model: string,
  auth: ResolveOrgModelConfigAuth | undefined,
  modelSelection?: ModelSelection,
  modelWorkload?: ModelWorkload,
): string {
  const authHash = createHash("sha256")
    .update(
      JSON.stringify({
        authorization: normalizeAuthHeader(auth) ?? "",
        scenarioId: auth?.scenarioId?.trim() ?? "",
        accessVersion:
          auth?.scenarioId &&
          auth.scenarioId.trim() &&
          Number.isFinite(auth?.accessVersion)
            ? auth.accessVersion
            : null,
        serverIds: normalizeServerIds(auth?.serverIds),
      }),
    )
    .digest("hex");
  // A selection-carrying resolve is re-authorized by the backend against its
  // connection; it must never be answered from a legacy (or another
  // connection's) cached entry. Admission facts also scope reuse: a text
  // chat must never authorize a tool/image call or an unattended run.
  const selectionPart = modelSelection
    ? `:selection:${createHash("sha256").update(selectionKey(modelSelection)).digest("hex")}`
    : "";
  return `runtime:${formatTargetForCache(
    target,
  )}:${providerKey}:${model}:auth:${authHash}${selectionPart}:workload:${JSON.stringify(
    modelWorkload ?? null,
  )}`;
}

/** Only an `org` selection is ever sent to `/stream/org/resolve`. */
export function orgSelectionOnly(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  return selection?.source === "org" ? selection : undefined;
}

export function cacheRuntimeAnswer(
  cacheKey: string,
  result: OrgProviderRuntime,
): void {
  const writeNow = Date.now();
  pruneRuntimeResolveCache(writeNow);
  if (!githubExecutionPolicy()) {
    runtimeResolveCache.set(cacheKey, {
      result,
      expiresAt: writeNow + RUNTIME_CACHE_TTL_MS,
    });
  }
}

/** One uncached `/stream/org/resolve` request. */
export async function requestOrgProviderRuntime(
  convexHttpUrl: string,
  { target, providerKey, model, auth, options }: LocalOrgAttemptRequest,
  abortSignal?: AbortSignal,
): Promise<OrgProviderRuntime> {
  const modelSelection = orgSelectionOnly(options?.modelSelection);
  const modelWorkload = options?.modelWorkload;
  const authHeader = normalizeAuthHeader(auth);
  const serverIds = normalizeServerIds(auth?.serverIds);

  const url = `${convexHttpUrl.replace(/\/$/, "")}/stream/org/resolve`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  const abortWithCaller = () => controller.abort();
  if (abortSignal?.aborted) controller.abort();
  abortSignal?.addEventListener("abort", abortWithCaller, { once: true });

  let result: OrgProviderRuntime;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        ...target,
        providerKey,
        model,
        ...(auth?.scenarioId?.trim()
          ? { scenarioId: auth.scenarioId.trim() }
          : {}),
        ...(auth?.scenarioId?.trim() && Number.isFinite(auth?.accessVersion)
          ? { accessVersion: auth.accessVersion }
          : {}),
        ...(serverIds.length > 0 ? { serverIds } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(modelWorkload ? { modelWorkload } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch((error) => {
        // The HTTP status still refuses this request when its body is unreadable.
        logger.debug("Org runtime refusal body could not be read", {
          status: response.status,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        return "";
      });
      let message = `Org runtime resolution failed (${response.status})`;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(body);
        message = backendFailureText({
          source: "org-model-config",
          status: response.status,
          detail: parsed?.error,
          fallback: message,
        });
        if (typeof parsed?.code === "string" && parsed.code.trim()) {
          code = parsed.code.trim().toLowerCase();
        }
      } catch (error) {
        // Preserve the HTTP refusal even when the backend returns no JSON code.
        logger.debug("Org runtime refusal body was not JSON", {
          status: response.status,
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
      throw orgRuntimeResolveFailure(response.status, message, code);
    }

    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      runtimeLocation?: string;
      provider?: unknown;
      providerKey?: unknown;
    };
    if (!data?.ok) {
      throw new Error(
        backendFailureText({
          source: "org-model-config",
          status: response.status,
          detail: data?.error,
          fallback: "Failed to resolve org provider runtime",
        }),
      );
    }

    if (data.runtimeLocation === "local") {
      const rawProvider = data.provider as
        | Partial<OrgProviderResolvedConfig>
        | undefined;
      if (
        !rawProvider ||
        typeof rawProvider.providerKey !== "string" ||
        rawProvider.providerKey.length === 0
      ) {
        throw new Error(
          "Org runtime resolve returned invalid local provider config",
        );
      }
      // SSRF guard: in hosted mode reject baseUrls that point to private,
      // loopback, link-local, or cloud-metadata addresses — including
      // public hostnames that DNS-resolve to such IPs (DNS rebinding).
      // In local-inspector mode (CLI/desktop) private IPs are legitimate.
      if (
        HOSTED_MODE &&
        typeof rawProvider.baseUrl === "string" &&
        rawProvider.baseUrl.length > 0
      ) {
        await assertSafeHostedOutboundUrl(rawProvider.baseUrl);
      }
      result = {
        runtimeLocation: "local",
        provider: rawProvider as OrgProviderResolvedConfig,
      };
    } else {
      const resolvedKey =
        typeof data.providerKey === "string" &&
        data.providerKey.trim().length > 0
          ? data.providerKey
          : providerKey;
      result = {
        runtimeLocation: "cloud",
        providerKey: resolvedKey,
      };
    }
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abortWithCaller);
  }
  return result;
}

const ATTEMPT_UNANSWERED_REASON =
  "MCPJam could not confirm that this organization connection may still be " +
  "used, so nothing was sent to the provider. Try again in a moment.";

const ATTEMPT_MOVED_TO_CLOUD_REASON =
  "This organization connection no longer runs on this machine (its runtime " +
  "is now cloud), so nothing was sent to the provider. Run it again.";

/**
 * Ask the backend, never the cache, whether one provider attempt on an
 * organization's local runtime may run now, and return the provider config
 * to run it with (a rotated key or a moved endpoint included).
 *
 * The local runtime calls the provider from this process, where the backend
 * cannot refuse a call. So every attempt asks first: each step of a tool
 * loop and each retry, not only the first call of a turn. That is what stops
 * a running turn once an admin turns on "Use your keys for all AI features"
 * or turns the connection off, however long the turn has been running and
 * whatever the cache holds.
 *
 * Fails closed, and the cached answer to the same question is dropped so the
 * next turn asks the backend too:
 * - a refusal keeps the backend's code (`org_keys_required` once the org
 *   requires its own keys, `credential_missing` for a connection turned off
 *   or removed, ...);
 * - an answer that moved the connection to the cloud runtime carries no key,
 *   so the attempt does not run;
 * - no answer (network failure, timeout, a failure without a code) is
 *   `ai_key_policy_unavailable`, which is temporary.
 *
 * Cancelling the attempt cancels the request, and its abort error is
 * rethrown as is.
 */
export async function admitLocalOrgAttempt(
  request: LocalOrgAttemptRequest,
  attempt?: { abortSignal?: AbortSignal },
): Promise<OrgProviderResolvedConfig> {
  const modelSelection = orgSelectionOnly(request.options?.modelSelection);
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) throw new Error("CONVEX_HTTP_URL is not set");

  await verifyGithubCredentialAccess();
  const cacheKey = buildRuntimeCacheKey(
    request.target,
    request.providerKey,
    request.model,
    request.auth,
    modelSelection,
    request.options?.modelWorkload,
  );
  let result: OrgProviderRuntime;
  try {
    result = await requestOrgProviderRuntime(
      convexHttpUrl,
      request,
      attempt?.abortSignal,
    );
  } catch (error) {
    runtimeResolveCache.delete(cacheKey);
    if (attempt?.abortSignal?.aborted) throw error;
    throw attemptAdmissionFailure(error);
  }
  if (result.runtimeLocation !== "local") {
    runtimeResolveCache.delete(cacheKey);
    throw new Error(ATTEMPT_MOVED_TO_CLOUD_REASON);
  }
  cacheRuntimeAnswer(cacheKey, result);
  return result.provider;
}

/**
 * A refusal keeps its own error (and code). Anything else means the attempt
 * could not be authorized, which is refused as `ai_key_policy_unavailable`.
 */
function attemptAdmissionFailure(error: unknown): Error {
  if (error instanceof ModelResolutionRefusalError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (
    error instanceof Error &&
    typeof code === "string" &&
    isOrgKeyPolicyRefusalCode(code)
  ) {
    return error;
  }
  const cause = error instanceof Error ? error.message : String(error);
  return Object.assign(
    new Error(
      `ai_key_policy_unavailable: ${ATTEMPT_UNANSWERED_REASON} (${cause})`,
    ),
    { code: "ai_key_policy_unavailable", cause: error },
  );
}

/**
 * The error a non-OK `/stream/org/resolve` throws.
 *
 * A configuration refusal from the organization's AI-key policy
 * (`org_keys_required` when the org requires its own keys and the connection
 * runs on a local runtime, `credential_missing`, …) becomes a typed
 * {@link ModelResolutionRefusalError} carrying the backend's code: every
 * caller already treats that as "refused before execution" (an eval
 * iteration's `setup_failed`, a chat turn's refusal), never as an outage to
 * retry or a reason to fall back to another rail. The policy's transient
 * refusals (`ai_key_policy_unavailable`, `provider_unavailable`) stay ordinary
 * errors with the code attached, so they remain retryable.
 */
export function orgRuntimeResolveFailure(
  status: number,
  message: string,
  code: string | undefined,
): Error {
  if (code && isAiConfigurationRefusalCode(code)) {
    return new ModelResolutionRefusalError([
      {
        code: code as ModelRefusalCode,
        reason: message,
        evidence: { httpStatus: status, route: "/stream/org/resolve" },
      },
    ]);
  }
  const error = new Error(message);
  if (code && isOrgKeyPolicyRefusalCode(code)) {
    return Object.assign(error, { code, status });
  }
  return error;
}
