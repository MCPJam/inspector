import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseLLMString,
  type ParsedLLMString,
  createModelFromString,
  buildOrgModelFromResolvedConfig,
  assertOrgModelAllowed,
  OrgProviderConfigError,
  type BaseUrls,
  type CreateModelOptions,
  type OrgProviderResolvedConfig,
} from "../src/model-factory";

// Mock all provider packages
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "anthropic",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "openai",
      modelId,
      type: "mock-model",
    }));
    modelFn.chat = vi.fn((modelId: string) => ({
      provider: "openai-chat",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "deepseek",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "google",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "azure",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "mistral",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/xai", () => ({
  createXai: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "xai",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "openrouter",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "ollama",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: vi.fn(() => {
    const modelFn = vi.fn((modelId: string) => ({
      provider: "bedrock",
      modelId,
      type: "mock-model",
    }));
    return modelFn;
  }),
}));

// Import mocked modules for assertions
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAzure } from "@ai-sdk/azure";
import { createMistral } from "@ai-sdk/mistral";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

describe("model-factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseLLMString", () => {
    it("should parse simple provider/model string", () => {
      const result = parseLLMString("openai/gpt-4o");
      expect(result).toEqual({
        type: "builtin",
        provider: "openai",
        model: "gpt-4o",
      });
    });

    it("should parse provider with model containing slashes", () => {
      const result = parseLLMString("openrouter/anthropic/claude-3-opus");
      expect(result).toEqual({
        type: "builtin",
        provider: "openrouter",
        model: "anthropic/claude-3-opus",
      });
    });

    it("should handle all valid built-in providers", () => {
      const providers = [
        "anthropic",
        "openai",
        "azure",
        "bedrock",
        "deepseek",
        "google",
        "ollama",
        "mistral",
        "openrouter",
        "xai",
      ];

      for (const provider of providers) {
        const result = parseLLMString(`${provider}/test-model`);
        expect(result).toEqual({
          type: "builtin",
          provider,
          model: "test-model",
        });
      }
    });

    it("should parse custom provider when registered", () => {
      const customProviders = new Set(["litellm", "my-custom"]);
      const result = parseLLMString("litellm/gpt-4", customProviders);
      expect(result).toEqual({
        type: "custom",
        providerName: "litellm",
        model: "gpt-4",
      });
    });

    it("should throw error for invalid format without slash", () => {
      expect(() => parseLLMString("gpt-4o")).toThrow(
        'Invalid LLM string format: "gpt-4o". Expected format: "provider/model"'
      );
    });

    it("should name openrouter in the bare-id error, because that is where a hosted id routes", () => {
      // A customer holding a catalog id has been told to paste it somewhere.
      // The one error left tells them what shape it must have and why a vendor
      // they do not recognise as a provider is still accepted.
      expect(() => parseLLMString("claude-haiku-4.5")).toThrow(/openrouter/);
      expect(() => parseLLMString("claude-haiku-4.5")).toThrow(
        /anthropic\/claude-haiku-4\.5/
      );
    });

    it("should throw error for empty string", () => {
      expect(() => parseLLMString("")).toThrow("Invalid LLM string format");
    });

    // ── Hosted-catalog ids ──────────────────────────────────────────────────
    //
    // `list_models` and the model picker hand out canonical OpenRouter-style
    // ids whose first segment is a VENDOR, not an MCPJam provider. Every row
    // below with a non-builtin vendor threw `Unknown LLM provider` before, so
    // this table is strictly widening: the two rows that parsed then still
    // parse to exactly the same thing.
    describe("hosted catalog ids", () => {
      const cases: Array<{
        label: string;
        id: string;
        expected: ParsedLLMString;
      }> = [
        {
          label: "a built-in vendor is untouched",
          id: "anthropic/claude-haiku-4.5",
          expected: {
            type: "builtin",
            provider: "anthropic",
            model: "claude-haiku-4.5",
          },
        },
        {
          label: "an explicit openrouter prefix is untouched",
          id: "openrouter/anthropic/claude-haiku-4.5",
          expected: {
            type: "builtin",
            provider: "openrouter",
            model: "anthropic/claude-haiku-4.5",
          },
        },
        {
          label: "an unknown vendor is an openrouter path, id and all",
          id: "qwen/qwen3-max",
          expected: {
            type: "builtin",
            provider: "openrouter",
            model: "qwen/qwen3-max",
          },
        },
        {
          label: "a vendor path keeps its own slashes",
          id: "z-ai/glm-4.6/thinking",
          expected: {
            type: "builtin",
            provider: "openrouter",
            model: "z-ai/glm-4.6/thinking",
          },
        },
        {
          label: "x-ai resolves through the alias table",
          id: "x-ai/grok-4-fast",
          expected: {
            type: "builtin",
            provider: "xai",
            model: "grok-4-fast",
          },
        },
        {
          label: "mistralai resolves through the alias table",
          id: "mistralai/mistral-large-2411",
          expected: {
            type: "builtin",
            provider: "mistral",
            model: "mistral-large-2411",
          },
        },
        {
          label:
            "meta-llama aliases to a non-builtin, so it stays an openrouter path",
          id: "meta-llama/llama-3.3-70b-instruct",
          expected: {
            type: "builtin",
            provider: "openrouter",
            model: "meta-llama/llama-3.3-70b-instruct",
          },
        },
      ];

      for (const { label, id, expected } of cases) {
        it(label, () => {
          expect(parseLLMString(id)).toEqual(expected);
        });
      }

      it("still throws for an EMPTY segment ANYWHERE, doubled slashes too", () => {
        // `parseLLMString` is exported, so a caller can hand it these. Passing
        // them through to OpenRouter would turn an obvious local mistake into
        // a remote API error. The middle cases are why the guard reads the raw
        // segments: a doubled slash leaves the provider and the re-joined
        // model both non-empty.
        //
        // The last two are ALIAS prefixes, and they are the reason the guard
        // sits above the alias table rather than below it: resolved first,
        // `x-ai/` would be an xai model with no name and `mistralai//model` a
        // Mistral model called `/model`.
        for (const malformed of [
          "/qwen3-max",
          "qwen/",
          "qwen//qwen3-max",
          "qwen//",
          "x-ai/",
          "mistralai//model",
        ]) {
          expect(() => parseLLMString(malformed), malformed).toThrow(
            "Invalid LLM string format"
          );
        }
      });

      it("leaves a BUILT-IN prefix alone, empty tail and all", () => {
        // The boundary, stated so it is a decision rather than an oversight:
        // the guard sits below the built-in and custom-provider checks. Those
        // two are the paths that existed before this parser learned the hosted
        // catalog, and they keep the shape they have always had — tightening
        // them would change a string that parses today, which this change
        // deliberately never does. Everything the guard does cover used to
        // throw.
        expect(parseLLMString("openai/")).toEqual({
          type: "builtin",
          provider: "openai",
          model: "",
        });
        expect(parseLLMString("openrouter//anthropic/claude-haiku-4.5")).toEqual(
          {
            type: "builtin",
            provider: "openrouter",
            model: "/anthropic/claude-haiku-4.5",
          }
        );
      });

      it("still throws for a bare id with no vendor segment", () => {
        expect(() => parseLLMString("qwen3-max")).toThrow(
          "Invalid LLM string format"
        );
      });

      it("does not let an alias shadow a registered custom provider", () => {
        // Someone who registered a custom provider called `mistralai` was
        // getting a custom provider before this change and must keep getting
        // one: the alias only fires where the parser used to throw.
        expect(
          parseLLMString("mistralai/whatever", new Set(["mistralai"]))
        ).toEqual({
          type: "custom",
          providerName: "mistralai",
          model: "whatever",
        });
      });
    });

    // The ratchet. The hosted catalog grows on every backend deploy that widens
    // it; this walks the committed snapshot of it so a newly added vendor
    // cannot reintroduce the construction-time throw this change removed.
    it("parses every id in the hosted model catalog snapshot", () => {
      const snapshotPath = fileURLToPath(
        new URL(
          "../../mcpjam-inspector/shared/hosted-model-ids.generated.ts",
          import.meta.url
        )
      );
      const source = readFileSync(snapshotPath, "utf8");
      const ids = [...source.matchAll(/"([^"\n]+)"/g)]
        .map((match) => match[1])
        .filter((id) => id.includes("/"));

      expect(ids.length).toBeGreaterThan(100);

      // Parsing at all is the whole assertion: no custom providers are
      // registered here, so the only outcomes are a builtin/OpenRouter
      // resolution or the throw this change exists to remove.
      const failures: string[] = [];
      for (const id of ids) {
        try {
          parseLLMString(id);
        } catch (error) {
          failures.push(`${id}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe("createModelFromString", () => {
    const defaultOptions: CreateModelOptions = {
      apiKey: "test-api-key",
    };

    describe("anthropic provider", () => {
      it("should create anthropic model with api key", () => {
        createModelFromString("anthropic/claude-3-opus", defaultOptions);

        expect(createAnthropic).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });

      it("should pass custom base URL when provided", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: { anthropic: "https://custom.anthropic.com" },
        };

        createModelFromString("anthropic/claude-3-opus", options);

        expect(createAnthropic).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: "https://custom.anthropic.com",
        });
      });
    });

    describe("openai provider", () => {
      it("should create openai model with api key", () => {
        createModelFromString("openai/gpt-4o", defaultOptions);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });

      it("should pass custom base URL when provided", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: { openai: "https://custom.openai.com" },
        };

        createModelFromString("openai/gpt-4o", options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: "https://custom.openai.com",
        });
      });
    });

    describe("deepseek provider", () => {
      it("should create deepseek model with api key", () => {
        createModelFromString("deepseek/deepseek-chat", defaultOptions);

        expect(createDeepSeek).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });
    });

    describe("google provider", () => {
      it("should create google model with api key", () => {
        createModelFromString("google/gemini-pro", defaultOptions);

        expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });
    });

    describe("ollama provider", () => {
      it("should create ollama model with default base URL", () => {
        createModelFromString("ollama/llama2", defaultOptions);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: "http://127.0.0.1:11434/api",
        });
      });

      it("should normalize base URL without /api suffix", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: { ollama: "http://localhost:11434" },
        };

        createModelFromString("ollama/llama2", options);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: "http://localhost:11434/api",
        });
      });

      it("should keep base URL with /api suffix", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: { ollama: "http://localhost:11434/api" },
        };

        createModelFromString("ollama/llama2", options);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: "http://localhost:11434/api",
        });
      });

      it("should handle base URL with trailing slash", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: { ollama: "http://localhost:11434/" },
        };

        createModelFromString("ollama/llama2", options);

        expect(createOllama).toHaveBeenCalledWith({
          baseURL: "http://localhost:11434/api",
        });
      });
    });

    describe("mistral provider", () => {
      it("should create mistral model with api key", () => {
        createModelFromString("mistral/mistral-large", defaultOptions);

        expect(createMistral).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });
    });

    describe("custom provider (litellm)", () => {
      it("should create model from custom provider", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          customProviders: {
            litellm: {
              name: "litellm",
              protocol: "openai-compatible",
              baseUrl: "http://localhost:4000",
              modelIds: ["gpt-4"],
              useChatCompletions: true,
            },
          },
        };

        createModelFromString("litellm/gpt-4", options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: "http://localhost:4000",
        });
      });

      it("should use custom base URL from provider config", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          customProviders: {
            litellm: {
              name: "litellm",
              protocol: "openai-compatible",
              baseUrl: "http://litellm.local:8080",
              modelIds: ["gpt-4"],
              useChatCompletions: true,
            },
          },
        };

        createModelFromString("litellm/gpt-4", options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: "http://litellm.local:8080",
        });
      });

      it("should use apiKeyEnvVar from custom provider config", () => {
        const originalEnv = process.env.LITELLM_API_KEY;
        process.env.LITELLM_API_KEY = "env-api-key";

        const options: CreateModelOptions = {
          apiKey: "",
          customProviders: {
            litellm: {
              name: "litellm",
              protocol: "openai-compatible",
              baseUrl: "http://localhost:4000",
              modelIds: ["gpt-4"],
              apiKeyEnvVar: "LITELLM_API_KEY",
              useChatCompletions: true,
            },
          },
        };

        createModelFromString("litellm/gpt-4", options);

        expect(createOpenAI).toHaveBeenCalledWith({
          apiKey: "env-api-key",
          baseURL: "http://localhost:4000",
        });

        process.env.LITELLM_API_KEY = originalEnv;
      });
    });

    describe("openrouter provider", () => {
      it("should create openrouter model with api key", () => {
        createModelFromString(
          "openrouter/anthropic/claude-3-opus",
          defaultOptions
        );

        expect(createOpenRouter).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });
    });

    describe("xai provider", () => {
      it("should create xai model with api key", () => {
        createModelFromString("xai/grok-1", defaultOptions);

        expect(createXai).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });
    });

    describe("azure provider", () => {
      it("should create azure model with api key", () => {
        createModelFromString("azure/gpt-4", defaultOptions);

        expect(createAzure).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: undefined,
        });
      });

      it("should pass custom base URL when provided", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: { azure: "https://my-azure.openai.azure.com" },
        };

        createModelFromString("azure/gpt-4", options);

        expect(createAzure).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: "https://my-azure.openai.azure.com",
        });
      });
    });

    describe("bedrock provider", () => {
      it("should create bedrock model with api key", () => {
        createModelFromString(
          "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          defaultOptions
        );

        expect(createAmazonBedrock).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });

      it("should pass custom base URL when provided", () => {
        const options: CreateModelOptions = {
          apiKey: "test-api-key",
          baseUrls: {
            bedrock: "https://bedrock-runtime.eu-west-1.amazonaws.com",
          },
        };

        createModelFromString("bedrock/us.amazon.nova-pro-v1:0", options);

        expect(createAmazonBedrock).toHaveBeenCalledWith({
          apiKey: "test-api-key",
          baseURL: "https://bedrock-runtime.eu-west-1.amazonaws.com",
        });
      });
    });

    describe("hosted catalog vendor paths", () => {
      it("should build an openrouter model from a vendor path", () => {
        createModelFromString("qwen/qwen3-max", defaultOptions);

        expect(createOpenRouter).toHaveBeenCalledWith({
          apiKey: "test-api-key",
        });
      });
    });

    describe("error handling", () => {
      it("should throw for invalid format", () => {
        expect(() =>
          createModelFromString("invalid-format", defaultOptions)
        ).toThrow("Invalid LLM string format");
      });
    });
  });

  describe("BaseUrls interface", () => {
    it("should allow partial base URLs", () => {
      const baseUrls: BaseUrls = {
        openai: "https://custom.openai.com",
      };

      expect(baseUrls.openai).toBe("https://custom.openai.com");
      expect(baseUrls.anthropic).toBeUndefined();
    });

    it("should allow all base URLs", () => {
      const baseUrls: BaseUrls = {
        ollama: "http://localhost:11434",
        azure: "https://azure.openai.com",
        anthropic: "https://anthropic.com",
        openai: "https://openai.com",
      };

      expect(Object.keys(baseUrls)).toHaveLength(4);
    });
  });
});

// ---------------------------------------------------------------------------
// buildOrgModelFromResolvedConfig + assertOrgModelAllowed
// ---------------------------------------------------------------------------

describe("buildOrgModelFromResolvedConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("openai: calls createOpenAI with apiKey", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "openai",
      apiKey: "sk-test",
    };
    buildOrgModelFromResolvedConfig(config, "gpt-4o");
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: "sk-test" });
  });

  it("anthropic: calls createAnthropic with apiKey", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "anthropic",
      apiKey: "ant-test",
    };
    buildOrgModelFromResolvedConfig(config, "claude-3-5-sonnet-20241022");
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "ant-test" });
  });

  it("azure: extracts resourceName from baseUrl", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "azure",
      apiKey: "az-key",
      baseUrl: "https://my-resource.openai.azure.com",
    };
    buildOrgModelFromResolvedConfig(config, "gpt-4");
    expect(createAzure).toHaveBeenCalledWith({
      apiKey: "az-key",
      resourceName: "my-resource",
    });
  });

  it("azure: falls back to baseURL when resource name not parseable", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "azure",
      apiKey: "az-key",
      baseUrl: "https://custom.example.com/azure",
    };
    buildOrgModelFromResolvedConfig(config, "gpt-4");
    expect(createAzure).toHaveBeenCalledWith({
      apiKey: "az-key",
      baseURL: "https://custom.example.com/azure",
    });
  });

  it("openrouter: includes HTTP-Referer and X-Title headers", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "openrouter",
      apiKey: "or-key",
    };
    buildOrgModelFromResolvedConfig(config, "anthropic/claude-3-opus");
    expect(createOpenRouter).toHaveBeenCalledWith({
      apiKey: "or-key",
      headers: {
        "HTTP-Referer": "https://www.mcpjam.com/",
        "X-Title": "MCPJam",
      },
    });
  });

  it("bedrock: calls createAmazonBedrock with apiKey and baseURL", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "bedrock",
      apiKey: "bedrock-key",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    };
    buildOrgModelFromResolvedConfig(
      config,
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    );
    expect(createAmazonBedrock).toHaveBeenCalledWith({
      apiKey: "bedrock-key",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
    });
  });

  it("bedrock: throws provider_not_configured without baseUrl", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "bedrock",
      apiKey: "bedrock-key",
    };
    expect(() =>
      buildOrgModelFromResolvedConfig(config, "us.amazon.nova-pro-v1:0")
    ).toThrow(OrgProviderConfigError);
  });

  it("ollama: normalizes baseUrl to end with /api", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "ollama",
      baseUrl: "http://localhost:11434",
    };
    buildOrgModelFromResolvedConfig(config, "llama3");
    expect(createOllama).toHaveBeenCalledWith({
      baseURL: "http://localhost:11434/api",
    });
  });

  it("ollama: keeps baseUrl that already has /api", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "ollama",
      baseUrl: "http://localhost:11434/api",
    };
    buildOrgModelFromResolvedConfig(config, "llama3");
    expect(createOllama).toHaveBeenCalledWith({
      baseURL: "http://localhost:11434/api",
    });
  });

  it("ollama: throws when baseUrl is missing", () => {
    const config: OrgProviderResolvedConfig = { providerKey: "ollama" };
    expect(() =>
      buildOrgModelFromResolvedConfig(config, "llama3")
    ).toThrow(OrgProviderConfigError);
  });

  it("custom openai-compatible: strips providerKey prefix from modelId", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "custom:my-provider",
      apiKey: "key",
      baseUrl: "http://my-provider.local",
      protocol: "openai-compatible",
    };
    buildOrgModelFromResolvedConfig(config, "custom:my-provider:gpt-4");
    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "key",
      baseURL: "http://my-provider.local",
    });
  });

  it("custom anthropic-compatible: calls createAnthropic with baseUrl", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "custom:ant-compat",
      apiKey: "key",
      baseUrl: "http://ant-compat.local",
      protocol: "anthropic-compatible",
    };
    buildOrgModelFromResolvedConfig(config, "claude-haiku");
    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: "key",
      baseURL: "http://ant-compat.local",
    });
  });

  it("unsupported provider: throws OrgProviderConfigError", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "unknown-provider" as any,
    };
    expect(() =>
      buildOrgModelFromResolvedConfig(config, "model")
    ).toThrow(OrgProviderConfigError);
  });

  it("missing apiKey for cloud provider: throws OrgProviderConfigError", () => {
    const config: OrgProviderResolvedConfig = { providerKey: "openai" };
    expect(() =>
      buildOrgModelFromResolvedConfig(config, "gpt-4o")
    ).toThrow(OrgProviderConfigError);
  });
});

describe("assertOrgModelAllowed", () => {
  it("openrouter: allows model in selectedModels", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "openrouter",
      selectedModels: ["anthropic/claude-3-opus", "openai/gpt-4o"],
    };
    expect(() =>
      assertOrgModelAllowed(config, "anthropic/claude-3-opus")
    ).not.toThrow();
  });

  it("openrouter: rejects model not in selectedModels", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "openrouter",
      selectedModels: ["openai/gpt-4o"],
    };
    expect(() =>
      assertOrgModelAllowed(config, "anthropic/claude-3-opus")
    ).toThrow(OrgProviderConfigError);
  });

  it("openrouter: allows any model when selectedModels is empty", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "openrouter",
      selectedModels: [],
    };
    expect(() =>
      assertOrgModelAllowed(config, "anything/model")
    ).not.toThrow();
  });

  it("bedrock: allows model in selectedModels", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "bedrock",
      selectedModels: ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
    };
    expect(() =>
      assertOrgModelAllowed(
        config,
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
      )
    ).not.toThrow();
  });

  it("bedrock: rejects model not in selectedModels", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "bedrock",
      selectedModels: ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
    };
    expect(() =>
      assertOrgModelAllowed(config, "us.amazon.nova-pro-v1:0")
    ).toThrow(OrgProviderConfigError);
  });

  it("custom: allows model in modelIds (after prefix strip)", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "custom:my-provider",
      modelIds: ["gpt-4", "gpt-3.5-turbo"],
    };
    expect(() =>
      assertOrgModelAllowed(config, "custom:my-provider:gpt-4")
    ).not.toThrow();
  });

  it("custom: rejects model not in modelIds", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "custom:my-provider",
      modelIds: ["gpt-4"],
    };
    expect(() =>
      assertOrgModelAllowed(config, "custom:my-provider:gpt-5")
    ).toThrow(OrgProviderConfigError);
  });

  it("built-in providers: pass through without allowlist check", () => {
    const config: OrgProviderResolvedConfig = {
      providerKey: "anthropic",
    };
    expect(() =>
      assertOrgModelAllowed(config, "any-model-id")
    ).not.toThrow();
  });
});
