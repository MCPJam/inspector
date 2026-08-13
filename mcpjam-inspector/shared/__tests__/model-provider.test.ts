import { describe, expect, it } from "vitest";
import {
  MODEL_ID_PREFIX_ALIASES,
  MODEL_ID_PREFIX_TO_PROVIDER,
  classifyModelIdProvider,
  providerForModelId,
} from "../model-provider";
import { MODEL_PROVIDER_FIXTURES } from "./model-provider-fixtures";

describe("classifyModelIdProvider", () => {
  for (const fixture of MODEL_PROVIDER_FIXTURES) {
    it(`classifies ${JSON.stringify(fixture.id)} as ${fixture.provider}`, () => {
      const result = classifyModelIdProvider(fixture.id);
      if (fixture.provider === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      expect(result!.provider).toBe(fixture.provider);
      expect(result!.customProviderName).toBe(fixture.customProviderName);
    });
  }

  it("never guesses a provider for a blank id", () => {
    // The single most load-bearing rule: an unpinned host persists "" and the
    // bare-id catch-all would otherwise make it a plausible-looking Ollama
    // model that fails many hops downstream.
    expect(classifyModelIdProvider("")).toBeNull();
    expect(providerForModelId("")).toBeNull();
  });

  it("is total for every non-blank id", () => {
    for (const id of ["\x00", "???", "a".repeat(500), "://", "a/b/c/d"]) {
      expect(classifyModelIdProvider(id)).not.toBeNull();
    }
  });
});

describe("prefix map", () => {
  it("folds the aliases into the exported map", () => {
    for (const [prefix, provider] of Object.entries(MODEL_ID_PREFIX_ALIASES)) {
      expect(MODEL_ID_PREFIX_TO_PROVIDER[prefix]).toBe(provider);
      // An alias is by definition a prefix that is NOT its own provider.
      expect(prefix).not.toBe(provider);
    }
  });

  it("maps every identity prefix to itself", () => {
    const aliases = new Set(Object.keys(MODEL_ID_PREFIX_ALIASES));
    for (const [prefix, provider] of Object.entries(
      MODEL_ID_PREFIX_TO_PROVIDER
    )) {
      if (aliases.has(prefix)) continue;
      expect(provider).toBe(prefix);
    }
  });

  it("classifies every mapped prefix from a real-shaped id", () => {
    for (const [prefix, provider] of Object.entries(
      MODEL_ID_PREFIX_TO_PROVIDER
    )) {
      expect(providerForModelId(`${prefix}/some-model`)).toBe(provider);
    }
  });
});
