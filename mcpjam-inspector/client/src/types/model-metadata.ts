/**
 * OpenRouter model metadata types
 * These types match the backend API response from /models endpoint
 */

export interface OpenRouterModel {
  id: string;
  canonical_slug: string;
  name: string;
  created: number;
  pricing: {
    prompt: string;
    completion: string;
    request: string;
    image: string;
  };
  // Nullable to match the backend `CatalogModelDto`: a model with no known
  // context length renders "N/A" instead of a misleading 0.
  context_length: number | null;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    is_moderated: boolean;
    context_length: number | null;
    max_completion_tokens: number | null;
  };
  per_request_limits: any;
  supported_parameters: string[];
  default_parameters: any;
  description: string;
  // Whether MCPJam serves this model to signed-out guests (from the canonical
  // model capabilities, not the OpenRouter/Gateway catalog). Consumed by the
  // picker to gate guest-visible models.
  guestAllowed: boolean;
  // Which provider serves this model: 'gateway' when a Gateway price exists,
  // 'openrouter' for fallback models with no Gateway entry.
  providerSource: "gateway" | "openrouter";
}

export interface ModelMetadataResponse {
  ok: boolean;
  data?: OpenRouterModel[];
  error?: string;
}
