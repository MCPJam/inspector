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
import { resolveSyntheticModelSource } from "../org-model-config";

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
