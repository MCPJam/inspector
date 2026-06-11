/**
 * Contract tests for `resolveSyntheticModelSource` — the synthetic
 * runner's single source of truth for the three-way MCPJam vs cloud-BYOK
 * vs local-BYOK decision.
 *
 * Both `drainAssistantTurn` (turn dispatch) and the synthetic empty-session
 * persist fallback call this helper. Locking the shape here so the two
 * call sites can't drift.
 *
 * Scope: branches that DON'T require the Convex runtime resolver.
 * The local-runtime path (`resolveOrgProviderRuntime` Convex call) lives
 * in the same module as `resolveSyntheticModelSource`, so vitest's module
 * mock can't intercept the internal call (same-module calls bypass the
 * mock). That path is covered transitively by
 * `runner.dispatch.test.ts`, which mocks `resolveSyntheticModelSource`
 * itself.
 */
import { describe, expect, it } from "vitest";

import type { ModelDefinition } from "@/shared/types";
import {
  buildSyntheticModelDefinition,
  resolveSyntheticModelSource,
} from "../org-model-config";

describe("resolveSyntheticModelSource", () => {
  it("returns `mcpjam` source with no orgRuntime for MCPJam-catalog models", async () => {
    const result = await resolveSyntheticModelSource({
      modelDefinition: {
        id: "openai/gpt-oss-120b",
        name: "JAM model",
        provider: "openai",
      } as ModelDefinition,
      projectId: "proj-1",
    });

    expect(result).toEqual({ source: "mcpjam" });
  });

  it("returns `byok` + cloud orgRuntime for non-MCPJam providers that aren't local-runtime-eligible (no Convex round-trip)", async () => {
    // anthropic isn't in LOCAL_RUNTIME_ELIGIBLE_PROVIDERS and doesn't start
    // with `custom:`, so the resolver short-circuits to cloud without
    // hitting Convex. The test runs without CONVEX_HTTP_URL set on purpose
    // — if the short-circuit ever regresses, the test will fail with
    // "CONVEX_HTTP_URL is not set" rather than a silent behavior change.
    const result = await resolveSyntheticModelSource({
      modelDefinition: {
        id: "claude-3-5-sonnet-latest",
        name: "Claude",
        provider: "anthropic",
      } as ModelDefinition,
      projectId: "proj-1",
    });

    expect(result.source).toBe("byok");
    expect(result.orgRuntime).toEqual({
      runtimeLocation: "cloud",
      providerKey: "anthropic",
    });
  });

  it("throws on deriveOrgProviderKey failure (e.g. custom provider missing customProviderName)", async () => {
    await expect(
      resolveSyntheticModelSource({
        modelDefinition: {
          id: "custom-thing",
          name: "Custom",
          provider: "custom",
          // intentionally no customProviderName
        } as ModelDefinition,
        projectId: "proj-1",
      }),
    ).rejects.toThrow(/derive org provider key/i);
  });
});

describe("buildSyntheticModelDefinition", () => {
  it("returns the catalog definition unchanged for a SUPPORTED_MODELS id", () => {
    const result = buildSyntheticModelDefinition("openai/gpt-oss-120b");
    expect(result.id).toBe("openai/gpt-oss-120b");
    expect(result.provider).toBe("openai");
    // Catalog hits carry contextLength and other fields the BYOK fallbacks
    // can't derive — locking that round-trip stays intact.
    expect(result.contextLength).toBeDefined();
  });

  it("parses custom:NAME/... into provider='custom' + customProviderName", () => {
    const result = buildSyntheticModelDefinition(
      "custom:my-provider/some-model",
    );
    expect(result).toEqual({
      id: "custom:my-provider/some-model",
      name: "custom:my-provider/some-model",
      provider: "custom",
      customProviderName: "my-provider",
    });
  });

  it("derives provider from prefix for non-catalog known prefixes", () => {
    expect(
      buildSyntheticModelDefinition("anthropic/claude-3.5-sonnet").provider,
    ).toBe("anthropic");
    expect(
      buildSyntheticModelDefinition("meta-llama/llama-3.1-405b").provider,
    ).toBe("meta");
    expect(
      buildSyntheticModelDefinition("x-ai/grok-4").provider,
    ).toBe("xai");
    expect(
      buildSyntheticModelDefinition("ollama/llama-3:8b").provider,
    ).toBe("ollama");
  });

  it("derives provider='bedrock' for bare Bedrock-shaped ids", () => {
    // Org Bedrock models surface bare inference-profile ids in the picker,
    // so chatbox runtime configs store them without a "bedrock/" prefix.
    expect(
      buildSyntheticModelDefinition(
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ),
    ).toEqual({
      id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      name: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      provider: "bedrock",
    });
    // No geo prefix
    expect(
      buildSyntheticModelDefinition("amazon.nova-pro-v1:0").provider,
    ).toBe("bedrock");
    // Hyphenated geo prefix
    expect(
      buildSyntheticModelDefinition(
        "us-gov.anthropic.claude-3-5-haiku-20241022-v1:0",
      ).provider,
    ).toBe("bedrock");
    // Legacy ids without a ":N" revision suffix
    expect(buildSyntheticModelDefinition("anthropic.claude-v2").provider).toBe(
      "bedrock",
    );
    expect(
      buildSyntheticModelDefinition("amazon.titan-tg1-large").provider,
    ).toBe("bedrock");
    // Bedrock ARNs (inference profiles, imported models)
    expect(
      buildSyntheticModelDefinition(
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0",
      ).provider,
    ).toBe("bedrock");
  });

  it("falls back to provider='ollama' for bare ids (no slash, no recognized prefix)", () => {
    // Catalog never carries bare ids today, so the realistic BYOK case is
    // an Ollama-style local model stored on a chatbox runtime config.
    const result = buildSyntheticModelDefinition("llama-3:8b");
    expect(result).toEqual({
      id: "llama-3:8b",
      name: "llama-3:8b",
      provider: "ollama",
    });
    // Ollama ids with dots/tags must not be mistaken for Bedrock ids.
    expect(buildSyntheticModelDefinition("llama3.1:8b").provider).toBe(
      "ollama",
    );
    expect(buildSyntheticModelDefinition("qwen2.5:7b-instruct").provider).toBe(
      "ollama",
    );
    expect(buildSyntheticModelDefinition("mistral:latest").provider).toBe(
      "ollama",
    );
  });

  it("falls back to provider='ollama' when the prefix isn't in the catalog map", () => {
    // Unknown-prefix BYOK ids are vanishingly rare in practice but still
    // get a sensible default that deriveOrgProviderKey can act on.
    const result = buildSyntheticModelDefinition(
      "experimentalprovider/some-model",
    );
    expect(result.provider).toBe("ollama");
  });
});
