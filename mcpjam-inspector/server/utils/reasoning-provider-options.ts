/**
 * `providerOptions` fragment that asks a model to return its reasoning on its
 * own channel instead of inlining it in the text.
 *
 * Without it the AI SDK stream carries no `reasoning-*` parts, so the client's
 * `ReasoningPart` never renders and a model that inlines its scratch work
 * (DeepSeek-R1 wraps it in `<think>` tags) shows that scratch work as the
 * answer. BB-136.
 */

import type { ProviderOptions } from "@ai-sdk/provider-utils";

/** Anthropic rejects a budget below 1024; 4096 fits a real chain without a
 *  large latency cost on the short turns the Playground sends. */
const ANTHROPIC_THINKING_BUDGET_TOKENS = 4096;

/**
 * Keyed on the provider rather than the model id: BYOK ids are bare
 * (`claude-sonnet-4-5`) while the hosted catalog prefixes them
 * (`anthropic/claude-sonnet-4.5`), so an id-prefix match would never fire on
 * the inspector's own BYOK path.
 *
 * Returns a fresh object so callers can spread it into an existing
 * `providerOptions` without aliasing shared state.
 */
export function reasoningProviderOptions(
  provider: string | undefined,
): ProviderOptions {
  switch (provider?.toLowerCase()) {
    case "anthropic":
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
          },
        },
      };
    // OpenRouter documents `reasoning` as ignored by models that don't support
    // it, so this stays unconditional rather than carrying a hand-maintained
    // list of reasoning models — the kind of list that drifts (see BACK2-714).
    case "openrouter":
      return { openrouter: { reasoning: { enabled: true, effort: "medium" } } };
    default:
      return {};
  }
}
