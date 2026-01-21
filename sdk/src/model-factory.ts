/**
 * Model factory for creating AI SDK language models from provider/model strings.
 * Based on mcpjam-inspector/server/utils/chat-helpers.ts
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LLMProvider } from './types.js';

/**
 * Custom base URLs for providers that support them.
 */
export interface BaseUrls {
  ollama?: string;
  litellm?: string;
  azure?: string;
  anthropic?: string;
  openai?: string;
}

/**
 * Options for creating a model.
 */
export interface CreateModelOptions {
  apiKey: string;
  baseUrls?: BaseUrls;
}

/**
 * Parse an LLM string into provider and model components.
 * @param llmString - String in format "provider/model" (e.g., "openai/gpt-4o")
 * @returns Tuple of [provider, model]
 */
export function parseLLMString(llmString: string): [LLMProvider, string] {
  const parts = llmString.split('/');
  if (parts.length < 2) {
    throw new Error(
      `Invalid LLM string format: "${llmString}". Expected format: "provider/model" (e.g., "openai/gpt-4o")`
    );
  }

  const provider = parts[0] as LLMProvider;
  const model = parts.slice(1).join('/'); // Handle models with slashes in name

  const validProviders: LLMProvider[] = [
    'anthropic',
    'openai',
    'azure',
    'deepseek',
    'google',
    'ollama',
    'mistral',
    'litellm',
    'openrouter',
    'xai',
  ];

  if (!validProviders.includes(provider)) {
    throw new Error(
      `Unknown LLM provider: "${provider}". Supported providers: ${validProviders.join(', ')}`
    );
  }

  return [provider, model];
}

/**
 * Model type returned by provider factories.
 */
export type ProviderLanguageModel = ReturnType<
  ReturnType<typeof createOpenAI>
>;

/**
 * Create a language model from an LLM string.
 * @param llmString - String in format "provider/model" (e.g., "openai/gpt-4o")
 * @param options - API key and optional base URLs
 * @returns AI SDK language model instance
 */
export function createModelFromString(
  llmString: string,
  options: CreateModelOptions
): ProviderLanguageModel {
  const { apiKey, baseUrls } = options;
  const [provider, model] = parseLLMString(llmString);

  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey,
        ...(baseUrls?.anthropic && { baseURL: baseUrls.anthropic }),
      });
      return anthropic(model) as ProviderLanguageModel;
    }

    case 'openai': {
      const openai = createOpenAI({
        apiKey,
        ...(baseUrls?.openai && { baseURL: baseUrls.openai }),
      });
      return openai(model);
    }

    case 'deepseek': {
      const deepseek = createDeepSeek({ apiKey });
      return deepseek(model) as ProviderLanguageModel;
    }

    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model) as ProviderLanguageModel;
    }

    case 'ollama': {
      // Normalize the base URL to ensure it ends with /api
      const raw = baseUrls?.ollama || 'http://127.0.0.1:11434/api';
      const normalized = /\/api\/?$/.test(raw)
        ? raw
        : `${raw.replace(/\/+$/, '')}/api`;
      const ollama = createOllama({ baseURL: normalized });
      return ollama(model) as unknown as ProviderLanguageModel;
    }

    case 'mistral': {
      const mistral = createMistral({ apiKey });
      return mistral(model) as ProviderLanguageModel;
    }

    case 'litellm': {
      // LiteLLM uses OpenAI-compatible endpoints (standard chat completions API)
      const baseURL = baseUrls?.litellm || 'http://localhost:4000';
      const litellmApiKey = apiKey || process.env.LITELLM_API_KEY || '';
      const openai = createOpenAI({
        apiKey: litellmApiKey,
        baseURL,
      });
      // Use .chat() to use Chat Completions API instead of Responses API
      return openai.chat(model);
    }

    case 'openrouter': {
      const openrouter = createOpenRouter({ apiKey });
      return openrouter(model) as ProviderLanguageModel;
    }

    case 'xai': {
      const xai = createXai({ apiKey });
      return xai(model) as ProviderLanguageModel;
    }

    case 'azure': {
      const azure = createAzure({
        apiKey,
        baseURL: baseUrls?.azure,
      });
      return azure(model) as ProviderLanguageModel;
    }

    default: {
      const _exhaustiveCheck: never = provider;
      throw new Error(`Unhandled provider: ${_exhaustiveCheck}`);
    }
  }
}
