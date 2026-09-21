import { describe, expect, it } from "vitest";
import {
  MODEL_ID_PREFIX_ALIASES,
  MODEL_ID_PREFIX_TO_PROVIDER,
  RUNTIME_CHOSEN_MODEL_SENTINELS,
  classifyModelIdProvider,
  isRuntimeChosenModelSentinel,
  providerForModelId,
  runtimeChosenModelSentinelName,
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

describe("runtime-chosen sentinels", () => {
  it("recognizes cursor/auto and names it Cursor Auto", () => {
    expect(isRuntimeChosenModelSentinel("cursor/auto")).toBe(true);
    expect(runtimeChosenModelSentinelName("cursor/auto")).toBe("Cursor Auto");
  });

  it("still classifies the sentinel's provider honestly", () => {
    // Being a sentinel does NOT make the id providerless to the classifier —
    // `cursor` is a registered ModelProvider precisely so the id does not fall
    // through the bare-id rule to `ollama`. The two answers are independent:
    // one says who serves it, the other says "nobody, and that is the point".
    expect(providerForModelId("cursor/auto")).toBe("cursor");
  });

  it("says no for ordinary models, other cursor ids, and non-strings", () => {
    expect(isRuntimeChosenModelSentinel("anthropic/claude-haiku-4.5")).toBe(
      false
    );
    // Only the exact sentinel — a hypothetical real `cursor/...` id is not one.
    expect(isRuntimeChosenModelSentinel("cursor/gpt-5")).toBe(false);
    expect(isRuntimeChosenModelSentinel("")).toBe(false);
    expect(isRuntimeChosenModelSentinel(undefined)).toBe(false);
    expect(isRuntimeChosenModelSentinel(null)).toBe(false);
    expect(runtimeChosenModelSentinelName("anthropic/claude-haiku-4.5")).toBe(
      undefined
    );
  });

  it("tolerates surrounding whitespace, like the classifier does", () => {
    expect(isRuntimeChosenModelSentinel("  cursor/auto  ")).toBe(true);
    expect(runtimeChosenModelSentinelName(" cursor/auto")).toBe("Cursor Auto");
  });

  it("cannot be answered by Object.prototype keys", () => {
    // The table is null-prototype; a bare index would return a FUNCTION here
    // and read as a truthy display name.
    expect(isRuntimeChosenModelSentinel("constructor")).toBe(false);
    expect(runtimeChosenModelSentinelName("toString")).toBe(undefined);
  });

  it("gives every declared sentinel a non-empty display name", () => {
    const entries = Object.entries(RUNTIME_CHOSEN_MODEL_SENTINELS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, name] of entries) {
      expect(name.trim().length).toBeGreaterThan(0);
      expect(isRuntimeChosenModelSentinel(id)).toBe(true);
      expect(runtimeChosenModelSentinelName(id)).toBe(name);
    }
  });
});
