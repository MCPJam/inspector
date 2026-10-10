/**
 * Which inference rail each case runs on, the credentials that rail needs,
 * and how a provider's or the platform's refusal is attributed.
 *
 * ── Planning (no side effects) ──────────────────────────────────────────────
 *
 *   | mode      | model id                  | rail                              |
 *   |-----------|---------------------------|-----------------------------------|
 *   | auto      | provider id + its key     | BYOK                              |
 *   | auto      | provider id, no key       | MCPJam if the platform serves it  |
 *   | auto/mcpjam | `mcpjam/…`              | MCPJam                            |
 *   | byok      | `mcpjam/…`                | refused — explicit routing intent |
 *   | byok      | provider id               | BYOK, its key required            |
 *   | mcpjam    | provider id               | MCPJam, platform-served only      |
 *
 * There is no fallback after planning: a BYOK key the provider rejects is a
 * credential failure, never a reason to spend platform credits instead.
 *
 * ── Attribution ─────────────────────────────────────────────────────────────
 *
 * A rejected key, a billing refusal or a provider outage is not the server
 * under test failing its task. The runner wraps each iteration's language
 * model so such a refusal is recorded against that iteration before the
 * executor turns it into an error string — the iteration then reads as an
 * execution failure with a named cause, and the run as a credential or
 * billing problem rather than a measured failure.
 */

import { APICallError, RetryError } from "ai";
import {
  createModelFromString,
  parseLLMString,
  type CreateModelOptions,
} from "../model-factory.js";
import {
  McpjamLeaseError,
  classifyMcpjamLeaseError,
} from "../mcpjam-model-lease.js";
import { isLoopbackHost } from "../oauth/state-machines/shared/client-id-metadata.js";
import { redactTelemetryString } from "../telemetry-redaction.js";
import { setupStep } from "./deadline.js";
import {
  SuiteFileRunError,
  refusal,
  type SuiteFileRunProblem,
} from "./errors.js";
import type {
  McpjamInferenceConnection,
  SuiteFileInferenceMode,
  SuiteFileInferenceOptions,
  SuiteFileInferenceRail,
  SuiteFileRefusalAttribution,
} from "./types.js";

/** Providers a local BYOK run can reach with one API key. */
const KEYED_BYOK_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "openrouter",
  "xai",
]);

/** Providers that need no key (a local model server). */
const KEYLESS_BYOK_PROVIDERS = new Set(["ollama"]);

/** Vendors MCPJam-hosted inference serves — the lease proxy's protocols. */
const PLATFORM_VENDORS = new Set(["anthropic", "openai"]);

export type PlannedModel = {
  declaredModel: string;
  declaredProvider?: string;
  rail: SuiteFileInferenceRail;
  /** BYOK: the provider whose key is used. MCPJam: the vendor. */
  provider: string;
  /** The string the runner hands the model factory. */
  effectiveModel: string;
  /** MCPJam rail: the canonical id a lease is minted for. */
  canonicalModel?: string;
  /** BYOK rail: whether a key must be supplied. */
  needsKey: boolean;
};

/** One distinct (model, provider hint) pair, keyed for de-duplication. */
export function modelPlanKey(
  model: string,
  provider: string | undefined
): string {
  return `${model}\u0000${provider ?? ""}`;
}

/**
 * Resolve one declared model to a rail. Returns a problem instead of throwing
 * so every case's model is checked before anything is refused.
 */
export function planModel(args: {
  model: string;
  provider?: string;
  mode: SuiteFileInferenceMode;
  providerKeys: Readonly<Partial<Record<string, string>>>;
}):
  | { ok: true; plan: PlannedModel }
  | {
      ok: false;
      code: "MODEL_UNSUPPORTED" | "INFERENCE_CONFLICT";
      message: string;
    } {
  const declaredModel = args.model;
  const hint = args.provider?.trim().toLowerCase() || undefined;
  const model = declaredModel.trim();
  const declared = {
    declaredModel,
    ...(args.provider !== undefined ? { declaredProvider: args.provider } : {}),
  };

  if (model.startsWith("mcpjam/")) {
    if (args.mode === "byok") {
      return {
        ok: false,
        code: "INFERENCE_CONFLICT",
        message:
          `"${model}" names MCPJam-hosted inference, but BYOK inference was ` +
          "requested. The mcpjam/ prefix is explicit routing intent and is never " +
          "stripped; change the model id or the inference mode.",
      };
    }
    const canonical = model.slice("mcpjam/".length);
    const segments = canonical.split("/");
    if (segments.length < 2 || segments.some((segment) => segment === "")) {
      return {
        ok: false,
        code: "MODEL_UNSUPPORTED",
        message: `"${model}" is not an mcpjam/<vendor>/<model> id.`,
      };
    }
    const vendor = segments[0]!.toLowerCase();
    if (hint !== undefined && hint !== "mcpjam" && hint !== vendor) {
      return {
        ok: false,
        code: "INFERENCE_CONFLICT",
        message: `"${model}" is a ${vendor} model, but the suite's provider is "${args.provider}".`,
      };
    }
    if (!PLATFORM_VENDORS.has(vendor)) {
      return {
        ok: false,
        code: "MODEL_UNSUPPORTED",
        message: `MCPJam-hosted inference serves anthropic/* and openai/* models; "${model}" names "${vendor}".`,
      };
    }
    return {
      ok: true,
      plan: {
        ...declared,
        rail: "mcpjam",
        provider: vendor,
        effectiveModel: model,
        canonicalModel: canonical,
        needsKey: false,
      },
    };
  }

  const qualified = model.includes("/")
    ? model
    : hint !== undefined
      ? `${hint}/${model}`
      : undefined;
  if (qualified === undefined) {
    return {
      ok: false,
      code: "MODEL_UNSUPPORTED",
      message:
        `"${model}" names no provider. Write it as provider/model ` +
        '(e.g. "anthropic/claude-haiku-4.5"), or set defaults.provider.',
    };
  }
  let parsed: ReturnType<typeof parseLLMString>;
  try {
    parsed = parseLLMString(qualified);
  } catch (error) {
    return {
      ok: false,
      code: "MODEL_UNSUPPORTED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (parsed.type !== "builtin") {
    return {
      ok: false,
      code: "MODEL_UNSUPPORTED",
      message: `"${model}" needs a custom provider, which a local suite-file run does not configure.`,
    };
  }
  const provider = parsed.provider;
  if (model.includes("/") && hint !== undefined) {
    const firstSegment = model.split("/")[0]!.toLowerCase();
    if (hint !== provider && hint !== firstSegment) {
      return {
        ok: false,
        code: "INFERENCE_CONFLICT",
        message: `"${model}" resolves to provider "${provider}", but the suite's provider is "${args.provider}".`,
      };
    }
  }
  if (provider === "azure" || provider === "bedrock") {
    return {
      ok: false,
      code: "MODEL_UNSUPPORTED",
      message:
        `"${model}" needs ${provider} deployment configuration (resource or ` +
        "region) that a local suite-file run does not take. Use a keyed provider " +
        "id, or run the suite hosted.",
    };
  }

  const keyless = KEYLESS_BYOK_PROVIDERS.has(provider);
  const keyed = KEYED_BYOK_PROVIDERS.has(provider);
  const platformServed = PLATFORM_VENDORS.has(provider);
  const hasKey =
    typeof args.providerKeys[provider] === "string" &&
    args.providerKeys[provider]!.length > 0;
  const byok: PlannedModel = {
    ...declared,
    rail: "byok",
    provider,
    effectiveModel: `${provider}/${parsed.model}`,
    needsKey: keyed,
  };
  const platform: PlannedModel = {
    ...declared,
    rail: "mcpjam",
    provider,
    effectiveModel: `mcpjam/${provider}/${parsed.model}`,
    canonicalModel: `${provider}/${parsed.model}`,
    needsKey: false,
  };
  // The vendor-path fallback (`qwen/qwen3-max` → OpenRouter) keeps the whole
  // id as the model; `provider/model` would double the vendor.
  if (provider === "openrouter" && !model.startsWith("openrouter/")) {
    byok.effectiveModel = model;
  }

  switch (args.mode) {
    case "byok":
      if (!keyed && !keyless) {
        return {
          ok: false,
          code: "MODEL_UNSUPPORTED",
          message: `"${model}" (${provider}) is not reachable with a BYOK key from a local run.`,
        };
      }
      return { ok: true, plan: byok };
    case "mcpjam":
      if (!platformServed) {
        return {
          ok: false,
          code: "MODEL_UNSUPPORTED",
          message: `MCPJam-hosted inference serves anthropic/* and openai/* models; "${model}" is ${provider}.`,
        };
      }
      return { ok: true, plan: platform };
    case "auto":
      if (keyless || hasKey) return { ok: true, plan: byok };
      if (platformServed) return { ok: true, plan: platform };
      if (keyed) return { ok: true, plan: byok };
      return {
        ok: false,
        code: "MODEL_UNSUPPORTED",
        message: `"${model}" (${provider}) is not reachable from a local run.`,
      };
  }
}

/** Credentials resolved for the planned rails. Held in memory only. */
export type ResolvedInferenceCredentials = {
  providerKeys: Readonly<Partial<Record<string, string>>>;
  mcpjam?: McpjamInferenceConnection;
};

/**
 * Check that every planned rail has what it needs — without spending a model
 * call to validate a key. Resolves the platform connection only if a planned
 * case needs it.
 */
export async function resolveInferenceCredentials(args: {
  plans: readonly PlannedModel[];
  inference: SuiteFileInferenceOptions;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ResolvedInferenceCredentials> {
  const keys = args.inference.providerKeys ?? {};
  const problems: SuiteFileRunProblem[] = [];
  const reported = new Set<string>();
  for (const plan of args.plans) {
    if (plan.rail !== "byok" || !plan.needsKey) continue;
    const key = keys[plan.provider];
    if (typeof key === "string" && key.length > 0) continue;
    if (reported.has(plan.provider)) continue;
    reported.add(plan.provider);
    problems.push({
      model: plan.declaredModel,
      message: `no ${plan.provider} API key was supplied for BYOK inference.`,
    });
  }
  const needsPlatform = args.plans.some((plan) => plan.rail === "mcpjam");
  if (needsPlatform && !args.inference.resolveMcpjam) {
    problems.push({
      model: args.plans.find((plan) => plan.rail === "mcpjam")!.declaredModel,
      message:
        "MCPJam-hosted inference was selected but no MCPJam connection was supplied " +
        "(sign in, or supply a provider key for BYOK).",
    });
  }
  if (problems.length > 0) {
    throw refusal({
      code: "CREDENTIALS_MISSING",
      phase: "setup",
      category: "credentials",
      summary: "Model credentials are missing; nothing was run.",
      problems,
    });
  }
  if (!needsPlatform) return { providerKeys: keys };

  let connection: McpjamInferenceConnection;
  try {
    connection = await setupStep(
      "Resolving the MCPJam connection",
      args.timeoutMs,
      args.signal ?? new AbortController().signal,
      (signal) =>
        Promise.resolve().then(() => args.inference.resolveMcpjam!(signal))
    );
  } catch (error) {
    if (error instanceof SuiteFileRunError) throw error;
    if (args.signal?.aborted) throw error;
    throw new SuiteFileRunError({
      code: "CREDENTIALS_MISSING",
      phase: "setup",
      category: "credentials",
      message: `MCPJam-hosted inference could not be authorized: ${redactTelemetryString(
        error instanceof Error ? error.message : String(error)
      )}`,
    });
  }
  assertUsableConnection(connection);
  return { providerKeys: keys, mcpjam: connection };
}

function assertUsableConnection(connection: McpjamInferenceConnection): void {
  const problems: string[] = [];
  let origin: URL | undefined;
  try {
    origin = new URL(connection?.baseUrl ?? "");
  } catch {
    problems.push("baseUrl is not a URL");
  }
  if (origin && /\/api\/v1\/?$/.test(origin.pathname)) {
    problems.push(
      "baseUrl must be the MCPJam app origin, not its /api/v1 base (the lease client appends it)"
    );
  }
  if (
    origin &&
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))
  ) {
    problems.push(
      "baseUrl must be https:// — the platform credential is sent to it (a loopback http:// origin is allowed for local development)"
    );
  }
  if (
    typeof connection?.projectId !== "string" ||
    connection.projectId.trim() === ""
  ) {
    problems.push("projectId is required");
  } else if (connection.projectId === "default") {
    problems.push(
      'projectId must be a concrete project id; the "default" sentinel is not resolved here'
    );
  }
  if (typeof connection?.getAuth !== "function") {
    problems.push(
      "getAuth must be a function returning the current bearer token"
    );
  }
  if (problems.length > 0) {
    throw new SuiteFileRunError({
      code: "OPTIONS_INVALID",
      phase: "setup",
      category: "usage",
      message: `The MCPJam connection is unusable: ${problems.join("; ")}.`,
    });
  }
}

// ── attribution ──────────────────────────────────────────────────────────────

function leaseErrorFromBody(
  status: number,
  body: string | undefined
): McpjamLeaseError | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const envelope =
      parsed && typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : parsed;
    const code = typeof envelope.code === "string" ? envelope.code : undefined;
    const details =
      typeof envelope.details === "object" && envelope.details !== null
        ? (envelope.details as Record<string, unknown>)
        : undefined;
    if (code === undefined && details === undefined) return undefined;
    return new McpjamLeaseError("refused", {
      ...(code !== undefined ? { code } : {}),
      status,
      ...(details !== undefined ? { details } : {}),
    });
  } catch {
    return undefined;
  }
}

function fromLeaseKind(
  kind: ReturnType<typeof classifyMcpjamLeaseError>
): SuiteFileRefusalAttribution | undefined {
  switch (kind) {
    case "billing":
      return "billing";
    // The organization's AI-key policy, never the credential: a 403 (lease)
    // or 409 (proxy) carrying `org_keys_required` read as `credentials` would
    // send someone to rotate a key that works.
    case "policy":
      return "orgPolicy";
    case "auth":
      return "credentials";
    case "rateLimited":
      return "rateLimited";
    case "unavailable":
      return "unavailable";
    default:
      return undefined;
  }
}

/**
 * The model proxy's spend refusals carry only prose: an out-of-credit or
 * over-budget organization gets a 429 with `{ ok: false, error: "Spending
 * limit reached" }` or `"Organization spend budget reached"`. By status alone
 * that reads as a transient rate limit, and the run would keep scheduling
 * work against a proxy that will keep refusing.
 */
const PROXY_BILLING_REFUSAL =
  /spending limit reached|spend budget (?:is )?reached/i;

/**
 * Provider refusals outside 401/402/403, read from the error body: Gemini and
 * xAI reject a bad key with a 400, OpenAI reports an exhausted quota as a 429,
 * and Anthropic an exhausted credit balance as a 400.
 */
const PROVIDER_BILLING_REFUSAL =
  /insufficient_quota|exceeded your current quota|credit balance is too low|insufficient[_ ](?:balance|credits)/i;
const PROVIDER_CREDENTIAL_REFUSAL =
  /API_KEY_INVALID|API key not valid|incorrect API key|invalid[_ -]?(?:x-)?api[_ -]?key/i;

/** The prose in a `{ error: "…" }` body, else the body itself. */
function refusalText(body: string | undefined): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON: the text is the body.
  }
  return body;
}

/**
 * Name the refusal behind a model-call failure, if it was one. `undefined`
 * means "not a refusal we can attribute" — the error stays an ordinary
 * execution failure.
 */
export function classifyInferenceError(
  error: unknown,
  rail: SuiteFileInferenceRail
): SuiteFileRefusalAttribution | undefined {
  let current = error;
  if (RetryError.isInstance(current)) current = current.lastError;
  if (current instanceof McpjamLeaseError) {
    return fromLeaseKind(classifyMcpjamLeaseError(current));
  }
  if (APICallError.isInstance(current)) {
    const status = current.statusCode;
    if (status === undefined) return undefined;
    if (rail === "mcpjam") {
      const lease = leaseErrorFromBody(status, current.responseBody);
      if (lease) {
        const kind = fromLeaseKind(classifyMcpjamLeaseError(lease));
        if (kind) return kind;
      }
      if (PROXY_BILLING_REFUSAL.test(refusalText(current.responseBody)))
        return "billing";
    } else if (status >= 400 && status < 500) {
      // Billing first: a quota refusal is not a key to rotate.
      const body = current.responseBody ?? "";
      if (PROVIDER_BILLING_REFUSAL.test(body)) return "billing";
      if (PROVIDER_CREDENTIAL_REFUSAL.test(body)) return "credentials";
    }
    if (status === 401 || status === 403) return "credentials";
    if (status === 402) return "billing";
    if (status === 429) return "rateLimited";
    if (status >= 500) return "unavailable";
  }
  return undefined;
}

/** Upper bound on the provider's prose carried into a refusal message. */
const MAX_REFUSAL_TEXT_CHARS = 500;

/**
 * What a refused call said, for the iteration it failed: the error's own
 * message plus the body's prose when the message does not already carry it.
 * A body a provider SDK could not parse (the MCPJam proxy's `{ ok: false,
 * error }`, for one) leaves only the status text in the message — "Too Many
 * Requests" — and the reason the run stopped would never be shown.
 */
export function refusalMessage(error: unknown): string {
  const current = RetryError.isInstance(error) ? error.lastError : error;
  const message = redactTelemetryString(
    current instanceof Error ? current.message : String(current)
  );
  if (!APICallError.isInstance(current)) return message;
  const text = redactTelemetryString(refusalText(current.responseBody).trim());
  if (text === "" || message.includes(text)) return message;
  const bounded =
    text.length > MAX_REFUSAL_TEXT_CHARS
      ? `${text.slice(0, MAX_REFUSAL_TEXT_CHARS)}…`
      : text;
  return message.trim() === "" ? bounded : `${message}: ${bounded}`;
}

/**
 * Credential, billing and organization-policy refusals stop the run; the
 * others are transient.
 */
export function isTerminalRefusal(
  refusal: SuiteFileRefusalAttribution
): refusal is "credentials" | "billing" | "orgPolicy" {
  return (
    refusal === "credentials" ||
    refusal === "billing" ||
    refusal === "orgPolicy"
  );
}

/**
 * The sentence a run states for an organization-policy refusal: what was
 * refused and the one change that fixes it.
 */
export function orgPolicyRefusalMessage(model: string): string {
  return `This organization requires its own provider keys for AI features, so MCPJam refused the MCPJam-provided model ${model}. Choose a model from an organization provider (or run with your organization's provider key) and try again.`;
}

type LanguageModelFactory = (
  model: string,
  options: CreateModelOptions
) => ReturnType<typeof createModelFromString>;

/**
 * Wrap a model factory so every model it builds reports provider/platform
 * refusals to `onRefusal`, with the error, before rethrowing them unchanged —
 * and reports every call that succeeded to `onSuccess`, so a transient
 * refusal an AI SDK retry recovered from is never named as the cause of a
 * later failure. The wrapper keeps the model's own specification version;
 * only `doGenerate`/`doStream` are intercepted.
 */
export function attributingModelFactory(
  base: LanguageModelFactory,
  rail: SuiteFileInferenceRail,
  onRefusal: (refusal: SuiteFileRefusalAttribution, error: unknown) => void,
  onSuccess?: () => void
): LanguageModelFactory {
  return (model, options) => {
    const built = base(model, options);
    return new Proxy(built, {
      get(target, property, receiver) {
        if (property === "doGenerate" || property === "doStream") {
          const method = Reflect.get(target, property, receiver) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          return async (...args: unknown[]) => {
            let result: unknown;
            try {
              result = await method.apply(target, args);
            } catch (error) {
              const refusal = classifyInferenceError(error, rail);
              if (refusal) onRefusal(refusal, error);
              throw error;
            }
            onSuccess?.();
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };
}
