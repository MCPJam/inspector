import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import {
  applyGuestModelLocks,
  applyOutOfCreditsLocks,
  composeAvailableModels,
  GUEST_LOCKED_MODEL_REASON,
  OUT_OF_CREDITS_MODEL_REASON,
} from "../available-models";
import { getDefaultModel } from "../model-helpers";

// Catalog-sourced hosted models carrying the DTO `guestAllowed` flag.
const HOSTED_GUEST_GATED: ModelDefinition = {
  id: "newvendor/premium-model",
  name: "Premium",
  provider: "newvendor",
  hosted: true,
  guestAllowed: false,
};
const HOSTED_GUEST_OK: ModelDefinition = {
  id: "newvendor/free-model",
  name: "Free",
  provider: "newvendor",
  hosted: true,
  guestAllowed: true,
};
const BYOK: ModelDefinition = {
  id: "some/byok",
  name: "BYOK",
  provider: "openrouter",
};

describe("applyGuestModelLocks", () => {
  it("no-ops for authenticated users", () => {
    const models = [HOSTED_GUEST_GATED, HOSTED_GUEST_OK, BYOK];
    expect(applyGuestModelLocks(models, true)).toEqual(models);
  });

  it("locks guest-gated hosted models but leaves guest-allowed + BYOK enabled", () => {
    const [gated, ok, byok] = applyGuestModelLocks(
      [HOSTED_GUEST_GATED, HOSTED_GUEST_OK, BYOK],
      false
    );
    expect(gated.disabled).toBe(true);
    expect(gated.disabledReason).toBe(GUEST_LOCKED_MODEL_REASON);
    expect(ok.disabled).toBeUndefined();
    expect(byok.disabled).toBeUndefined();
  });

  it("defaults a hosted model with no guestAllowed flag to guest-gated (locked)", () => {
    const unknown: ModelDefinition = {
      id: "newvendor/unknown",
      name: "Unknown",
      provider: "newvendor",
      hosted: true,
    };
    const [locked] = applyGuestModelLocks([unknown], false);
    expect(locked.disabled).toBe(true);
  });
});

describe("applyOutOfCreditsLocks", () => {
  it("locks hosted (free) models but not BYOK when out of credits", () => {
    const [hosted, byok] = applyOutOfCreditsLocks(
      [HOSTED_GUEST_OK, BYOK],
      true
    );
    expect(hosted.disabled).toBe(true);
    expect(hosted.disabledReason).toBe(OUT_OF_CREDITS_MODEL_REASON);
    expect(byok.disabled).toBeUndefined();
  });

  it("no-ops when not out of credits", () => {
    const models = [HOSTED_GUEST_OK, BYOK];
    expect(applyOutOfCreditsLocks(models, false)).toEqual(models);
  });
});

describe("composeAvailableModels — never empty", () => {
  // The state that produced INSPECTOR-CLIENT-222: a caller handing composition
  // an empty hosted catalog (an `[]` survives the `?? snapshot()` default) with
  // no BYOK key, no Ollama and no custom provider to make up the difference.
  const bareParams = {
    isAuthenticated: true,
    isOllamaRunning: false,
    ollamaModels: [],
    hasToken: () => false,
    getOpenRouterSelectedModels: () => [],
    getAzureBaseUrl: () => "",
    customProviders: [],
    hostedCatalog: [],
  };

  it("falls back to the hosted snapshot when the local branch composes empty", () => {
    const models = composeAvailableModels({
      ...bareParams,
      orgConfig: undefined,
    });

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.hosted)).toBe(true);
  });

  it("falls back to the hosted snapshot when the org branch composes empty", () => {
    const models = composeAvailableModels({
      ...bareParams,
      // A configured provider with no stored secret contributes no models, so
      // the org branch is taken and still yields nothing on its own.
      orgConfig: {
        providers: [{ providerKey: "openai", enabled: true, hasSecret: false }],
      },
    });

    expect(models.length).toBeGreaterThan(0);
  });

  it("holds the floor for a signed-out guest too", () => {
    const models = composeAvailableModels({
      ...bareParams,
      orgConfig: undefined,
      isAuthenticated: false,
    });

    expect(models.length).toBeGreaterThan(0);
  });

  // The invariant the Playground actually depends on: `getDefaultModel` ends in
  // `availableModels[0]`, so an empty list is what left `selectedModel`
  // undefined and crashed the route.
  it("always yields a default model for the chat to select", () => {
    expect(
      getDefaultModel(
        composeAvailableModels({ ...bareParams, orgConfig: undefined })
      )
    ).toBeDefined();
  });
});
