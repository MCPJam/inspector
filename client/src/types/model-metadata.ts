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
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    is_moderated: boolean;
    context_length: number;
    max_completion_tokens: number;
  };
  per_request_limits: any;
  supported_parameters: string[];
  default_parameters: any;
  description: string;
}

export interface ModelMetadataResponse {
  ok: boolean;
  data?: OpenRouterModel[];
  error?: string;
}
