import {
  parseLLMString,
  createModelFromString,
  type BaseUrls,
  type CreateModelOptions,
} from '../src/model-factory';

// Mock all provider packages
jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'anthropic',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'openai',
      modelId,
      type: 'mock-model',
    }));
    modelFn.chat = jest.fn((modelId: string) => ({
      provider: 'openai-chat',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'deepseek',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'google',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@ai-sdk/azure', () => ({
  createAzure: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'azure',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@ai-sdk/mistral', () => ({
  createMistral: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'mistral',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@ai-sdk/xai', () => ({
  createXai: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'xai',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'openrouter',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

jest.mock('ollama-ai-provider-v2', () => ({
  createOllama: jest.fn(() => {
    const modelFn = jest.fn((modelId: string) => ({
      provider: 'ollama',
      modelId,
      type: 'mock-model',
    }));
    return modelFn;
  }),
}));

// Import mocked modules for assertions
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAzure } from '@ai-sdk/azure';
import { createMistral } from '@ai-sdk/mistral';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOllama } from 'ollama-ai-provider-v2';

describe('model-factory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseLLMString', () => {
    it('should parse simple provider/model string', () => {
      const [provider, model] = parseLLMString('openai/gpt-4o');
      expect(provider).toBe('openai');
      expect(model).toBe('gpt-4o');
    });

    it('should parse provider with model containing slashes', () => {
      const [provider, model] = parseLLMString('openrouter/anthropic/claude-3-opus');
      expect(provider).toBe('openrouter');
      expect(model).toBe('anthropic/claude-3-opus');
    });

    it('should handle all valid providers', () => {
      const providers = [
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

      for (const provider of providers) {
        const [parsedProvider, parsedModel] = parseLLMString(`${provider}/test-model`);
        expect(parsedProvider).toBe(provider);
        expect(parsedModel).toBe('test-model');
      }
    });

    it('should throw error for invalid format without slash', () => {
      expect(() => parseLLMString('gpt-4o')).toThrow(
        'Invalid LLM string format: "gpt-4o". Expected format: "provider/model"'
      );
    });

    it('should throw error for unknown provider', () => {
      expect(() => parseLLMString('unknown/model')).toThrow(
        'Unknown LLM provider: "unknown"'
      );
    });

    it('should throw error for empty string', () => {
      expect(() => parseLLMString('')).toThrow('Invalid LLM string format');
    });
  });

  describe('createModelFromString', () => {
    const defaultOptions: CreateModelOptions = {
      apiKey: 'test-api-key',
    };

    describe('anthropic provider', () => {
      it('should create anthropic model with api key', () => {
        createModelFromString('anthropic/claude-3-opus', defaultOptions);

        expect(createAnthropic).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });

      it('should pass custom base URL when provided', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { anthropic: 'https://custom.anthropic.com' },
        };

        createModelFromString('anthropic/claude-3-opus', options);

        expect(createAnthropic).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
          baseURL: 'https://custom.anthropic.com',
        });
      });
    });

    describe('openai provider', () => {
      it('should create openai model with api key', () => {
        createModelFromString('openai/gpt-4o', defaultOptions);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });

      it('should pass custom base URL when provided', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { openai: 'https://custom.openai.com' },
        };

        createModelFromString('openai/gpt-4o', options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
          baseURL: 'https://custom.openai.com',
        });
      });
    });

    describe('deepseek provider', () => {
      it('should create deepseek model with api key', () => {
        createModelFromString('deepseek/deepseek-chat', defaultOptions);

        expect(createDeepSeek).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });
    });

    describe('google provider', () => {
      it('should create google model with api key', () => {
        createModelFromString('google/gemini-pro', defaultOptions);

        expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });
    });

    describe('ollama provider', () => {
      it('should create ollama model with default base URL', () => {
        createModelFromString('ollama/llama2', defaultOptions);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: 'http://127.0.0.1:11434/api',
        });
      });

      it('should normalize base URL without /api suffix', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { ollama: 'http://localhost:11434' },
        };

        createModelFromString('ollama/llama2', options);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: 'http://localhost:11434/api',
        });
      });

      it('should keep base URL with /api suffix', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { ollama: 'http://localhost:11434/api' },
        };

        createModelFromString('ollama/llama2', options);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: 'http://localhost:11434/api',
        });
      });

      it('should handle base URL with trailing slash', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { ollama: 'http://localhost:11434/' },
        };

        createModelFromString('ollama/llama2', options);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: 'http://localhost:11434/api',
        });
      });
    });

    describe('mistral provider', () => {
      it('should create mistral model with api key', () => {
        createModelFromString('mistral/mistral-large', defaultOptions);

        expect(createMistral).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });
    });

    describe('litellm provider', () => {
      it('should create litellm model with default base URL', () => {
        createModelFromString('litellm/gpt-4', defaultOptions);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
          baseURL: 'http://localhost:4000',
        });
      });

      it('should use custom base URL when provided', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { litellm: 'http://litellm.local:8080' },
        };

        createModelFromString('litellm/gpt-4', options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
          baseURL: 'http://litellm.local:8080',
        });
      });

      it('should use LITELLM_API_KEY env var when apiKey is empty', () => {
        const originalEnv = process.env.LITELLM_API_KEY;
        process.env.LITELLM_API_KEY = 'env-api-key';

        const options: CreateModelOptions = {
          apiKey: '',
        };

        createModelFromString('litellm/gpt-4', options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: 'env-api-key',
          baseURL: 'http://localhost:4000',
        });

        process.env.LITELLM_API_KEY = originalEnv;
      });
    });

    describe('openrouter provider', () => {
      it('should create openrouter model with api key', () => {
        createModelFromString('openrouter/anthropic/claude-3-opus', defaultOptions);

        expect(createOpenRouter).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });
    });

    describe('xai provider', () => {
      it('should create xai model with api key', () => {
        createModelFromString('xai/grok-1', defaultOptions);

        expect(createXai).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
        });
      });
    });

    describe('azure provider', () => {
      it('should create azure model with api key', () => {
        createModelFromString('azure/gpt-4', defaultOptions);

        expect(createAzure).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
          baseURL: undefined,
        });
      });

      it('should pass custom base URL when provided', () => {
        const options: CreateModelOptions = {
          apiKey: 'test-api-key',
          baseUrls: { azure: 'https://my-azure.openai.azure.com' },
        };

        createModelFromString('azure/gpt-4', options);

        expect(createAzure).toHaveBeenCalledWith({
          apiKey: 'test-api-key',
          baseURL: 'https://my-azure.openai.azure.com',
        });
      });
    });

    describe('error handling', () => {
      it('should throw for unknown provider', () => {
        expect(() =>
          createModelFromString('unknown/model', defaultOptions)
        ).toThrow('Unknown LLM provider: "unknown"');
      });

      it('should throw for invalid format', () => {
        expect(() =>
          createModelFromString('invalid-format', defaultOptions)
        ).toThrow('Invalid LLM string format');
      });
    });
  });

  describe('BaseUrls interface', () => {
    it('should allow partial base URLs', () => {
      const baseUrls: BaseUrls = {
        openai: 'https://custom.openai.com',
      };

      expect(baseUrls.openai).toBe('https://custom.openai.com');
      expect(baseUrls.anthropic).toBeUndefined();
    });

    it('should allow all base URLs', () => {
      const baseUrls: BaseUrls = {
        ollama: 'http://localhost:11434',
        litellm: 'http://localhost:4000',
        azure: 'https://azure.openai.com',
        anthropic: 'https://anthropic.com',
        openai: 'https://openai.com',
      };

      expect(Object.keys(baseUrls)).toHaveLength(5);
    });
  });
});
