import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../services/hosted-model-catalog.js";
import { resolveModelContextTokens } from "../model-context-window.js";

afterEach(() => __resetHostedModelCatalogForTests());

describe("resolveModelContextTokens", () => {
  it("prefers the caller's own value", () => {
    __setHostedCatalogForTests(["anthropic/claude-haiku-4.5"], {
      "anthropic/claude-haiku-4.5": 200_000,
    });
    expect(
      resolveModelContextTokens("anthropic/claude-haiku-4.5", 64_000),
    ).toBe(64_000);
  });

  it("falls back to the hosted catalog for a hosted id", () => {
    __setHostedCatalogForTests(["anthropic/claude-haiku-4.5"], {
      "anthropic/claude-haiku-4.5": 200_000,
    });
    expect(resolveModelContextTokens("anthropic/claude-haiku-4.5")).toBe(
      200_000,
    );
  });

  it("falls back to the built-in model list", () => {
    expect(resolveModelContextTokens("gpt-4.1")).toBeGreaterThan(0);
  });

  it("treats invalid values as unknown", () => {
    expect(
      resolveModelContextTokens("someorg/private-model", Number.NaN),
    ).toBeUndefined();
    expect(
      resolveModelContextTokens("someorg/private-model", 0),
    ).toBeUndefined();
    expect(resolveModelContextTokens("someorg/private-model")).toBeUndefined();
  });
});
