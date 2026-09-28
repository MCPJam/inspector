/**
 * Copy for the one swarm failure MCPJam cannot fix: the user's own provider
 * key hit its rate limit mid-run.
 *
 * It is deliberately not the catalog's generic `provider/quota` wording. That
 * entry has to cover every surface, so it says "Your LLM provider rejected the
 * request"; here the host's configured provider is known, and naming it is the
 * difference between a guess and an answer. The slug and severity stay the
 * catalog's so the card renders amber like every other quota failure.
 */
import {
  humanizeSwarmAttemptError,
  isAccountLimit,
} from "@/shared/swarm-attempt-error";
import {
  describeError,
  mcpjamLimitSlugForMessage,
  describeAsSlug,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
import { classifyModelIdProvider } from "@/shared/model-provider";
import {
  describeProviderNotAllowlisted,
  isProviderNotAllowlistedCode,
} from "@/lib/provider-not-allowlisted";
import { getProviderDisplayName } from "@/lib/provider-registry";

/** Used whenever the model id does not name a provider outright. */
const GENERIC_PROVIDER_LABEL = "Your provider";

/**
 * Display name of the provider behind a model id, or {@link
 * GENERIC_PROVIDER_LABEL} when the id does not actually say.
 *
 * `classifyModelIdProvider` is total by design — every unprefixed id falls
 * through to `ollama`, which is how Ollama BYOK models are stored. Reading that
 * default as an answer would blame Ollama for a throttle that came from
 * somewhere else, so only an explicit `ollama/` prefix earns the name.
 */
export function providerLabelForModelId(modelId: string | undefined): string {
  const id = modelId?.trim();
  if (!id) return GENERIC_PROVIDER_LABEL;

  const classified = classifyModelIdProvider(id);
  if (!classified) return GENERIC_PROVIDER_LABEL;

  if (classified.provider === "ollama" && !/^ollama\//i.test(id)) {
    return GENERIC_PROVIDER_LABEL;
  }
  if (classified.provider === "custom") {
    return classified.customProviderName
      ? getProviderDisplayName(`custom:${classified.customProviderName}`)
      : GENERIC_PROVIDER_LABEL;
  }
  return getProviderDisplayName(classified.provider);
}

/**
 * The card shown on a session whose provider rate-limited the user's key.
 *
 * Rendered inline on the session, never as a modal: it happens mid-run, it is
 * per-session, and it is transient — a global interruption over a partial
 * failure would be wrong on all three counts.
 */
export function describeProviderRateLimit(
  providerLabel: string,
): NormalizedError {
  const oneLine = `${providerLabel} rate-limited this key. Retry again later or switch models.`;
  // Slug, severity, origin and docs link come from the catalog entry, so this
  // cannot drift from how every other quota failure renders. Only the copy —
  // which knows which provider it is talking about — is ours.
  return {
    ...describeAsSlug("provider/quota"),
    title: "Your provider hit its limit",
    oneLine,
    likelyCauses: [
      "Per-minute rate limit exceeded.",
      "Daily or monthly quota exhausted.",
      "Free tier limits hit.",
    ],
    // No MCPJam purchase appears here on purpose: no spend on MCPJam lifts a
    // limit the user's own provider imposed.
    nextSteps: [
      "Wait for the limit window to reset, then run the swarm again.",
      "Switch this host to a different model or provider.",
      "Raise the rate limit on your provider's own plan.",
    ],
    rawMessage: oneLine,
  };
}

/** Use the producer's humanized meaning, while retaining raw diagnostics. */
export function describeSwarmAttemptFailure(
  rawMessage: string | null | undefined,
  errorCode: string | null | undefined,
  providerLabel: string,
): NormalizedError {
  const info = humanizeSwarmAttemptError(rawMessage, errorCode);
  const code = errorCode ?? info.code;
  // The hosted gateway refused the host's model provider. Checked before the
  // status-driven paths below: read as a 401/403 it would card as a provider
  // credential failure and send the user to fix a key that was never used.
  if (
    isProviderNotAllowlistedCode(errorCode) ||
    isProviderNotAllowlistedCode(info.code)
  ) {
    return {
      ...describeProviderNotAllowlisted(info.message),
      rawMessage: rawMessage ?? info.message,
      rawCode: code,
    };
  }
  const limitSlug = mcpjamLimitSlugForMessage(info.message);
  if (
    isAccountLimit(info.message, code) &&
    (limitSlug ||
      ["user_rate_limit", "org_rate_limit", "billing_limit_reached"].includes(
        code ?? "",
      ))
  ) {
    return {
      ...describeAsSlug(limitSlug ?? "provider/mcpjam_limit"),
      oneLine: info.message,
      rawMessage: rawMessage ?? info.message,
      rawCode: code,
    };
  }
  const base = describeError(info.message);
  if (
    base.slug === "provider/quota" &&
    !isAccountLimit(info.message, errorCode ?? info.code)
  ) {
    return {
      ...describeProviderRateLimit(providerLabel),
      rawMessage: rawMessage ?? info.message,
      rawCode: errorCode ?? info.code,
    };
  }
  return {
    ...base,
    slug: "swarm/attempt_failed",
    title: info.rerunnable ? "Session needs another run" : "Session failed",
    oneLine: info.message,
    severity: info.rerunnable ? "info" : base.severity,
    nextSteps: info.rerunnable
      ? ["Run the session again to continue."]
      : base.nextSteps,
    rawMessage: rawMessage ?? info.message,
    rawCode: errorCode ?? info.code,
  };
}
