/**
 * THE parity vectors for provider classification.
 *
 * Two implementations answer "which provider serves this model id?": the
 * canonical one here (`shared/model-provider.ts`) and a hand-kept mirror in the
 * backend (`convex/lib/modelProviderClassification.ts` in mcpjam-backend, which
 * cannot import from this repo). This list is copied verbatim into that repo's
 * test so a rule change that lands in one and not the other fails loudly
 * instead of silently splitting eval attribution from chat attribution.
 *
 * Add a vector here AND there when you add a rule.
 */
export type ProviderFixture = {
  id: string;
  /** `null` ⇔ the id is blank and has no provider. */
  provider: string | null;
  customProviderName?: string;
};

export const MODEL_PROVIDER_FIXTURES: ProviderFixture[] = [
  // ── Blank: the one case with no answer ────────────────────────────────────
  { id: "", provider: null },
  { id: "   ", provider: null },
  { id: "\t\n", provider: null },

  // ── Prefix identity ───────────────────────────────────────────────────────
  { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
  { id: "azure/gpt-4o", provider: "azure" },
  { id: "bedrock/anthropic.claude-v2", provider: "bedrock" },
  { id: "deepseek/deepseek-chat", provider: "deepseek" },
  { id: "google/gemini-2.5-pro", provider: "google" },
  { id: "minimax/minimax-m2", provider: "minimax" },
  { id: "moonshotai/kimi-k2", provider: "moonshotai" },
  { id: "openai/gpt-5", provider: "openai" },
  { id: "ollama/llama3.1", provider: "ollama" },
  { id: "openrouter/auto", provider: "openrouter" },
  { id: "qwen/qwen3-max", provider: "qwen" },
  { id: "mistral/mistral-large", provider: "mistral" },
  { id: "z-ai/glm-4.6", provider: "z-ai" },

  // ── Prefix aliases ────────────────────────────────────────────────────────
  { id: "meta-llama/llama-4-maverick", provider: "meta" },
  // Regression: before the shared classifier this fell through every branch
  // and came back as `ollama`.
  { id: "mistralai/mistral-small-3.2-24b-instruct", provider: "mistral" },
  { id: "x-ai/grok-4", provider: "xai" },

  // ── Custom providers ──────────────────────────────────────────────────────
  {
    id: "custom:acme:my-model",
    provider: "custom",
    customProviderName: "acme",
  },
  {
    id: "custom:acme/my-model",
    provider: "custom",
    customProviderName: "acme",
  },
  // Slug only, no model segment — still a custom provider.
  { id: "custom:acme", provider: "custom", customProviderName: "acme" },
  // Degenerate: no slug at all. Custom, but nothing to name.
  { id: "custom:", provider: "custom" },
  // A `custom:` id whose model segment contains further colons keeps the FIRST
  // segment as the slug.
  {
    id: "custom:acme:vendor:model:v2",
    provider: "custom",
    customProviderName: "acme",
  },

  // ── Bare Bedrock shapes ───────────────────────────────────────────────────
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", provider: "bedrock" },
  { id: "eu.meta.llama3-2-11b-instruct-v1:0", provider: "bedrock" },
  { id: "anthropic.claude-v2", provider: "bedrock" },
  { id: "amazon.titan-tg1-large", provider: "bedrock" },
  {
    id: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    provider: "bedrock",
  },
  {
    id: "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/x",
    provider: "bedrock",
  },

  // ── Bare / unknown → ollama ───────────────────────────────────────────────
  { id: "llama3.1:8b", provider: "ollama" },
  { id: "mistral:latest", provider: "ollama" },
  { id: "claude-sonnet-4-5", provider: "ollama" },
  { id: "gpt-5", provider: "ollama" },
  // An UNRECOGNIZED prefix is not a provider — the whole id is treated as bare.
  { id: "acme-corp/some-model", provider: "ollama" },
  { id: "huggingface/some-model", provider: "ollama" },
  // A leading slash has no prefix segment (indexOf("/") === 0), so it is bare.
  { id: "/leading-slash", provider: "ollama" },
  // Surrounding whitespace is trimmed before classification.
  { id: "  anthropic/claude-sonnet-4-5  ", provider: "anthropic" },
];
