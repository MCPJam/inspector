import { describe, expect, it } from "vitest";
import { swarmTargetModelDefinition } from "../swarm-runner";

const none = { provider: "none", model: "none" } as const;

describe("swarmTargetModelDefinition", () => {
  it("legacy snapshot (no selection) keeps the pinned hosted flag and id lookup", () => {
    const definition = swarmTargetModelDefinition({
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(definition.id).toBe("anthropic/claude-haiku-4.5");
    expect(definition.hosted).toBeUndefined();
  });

  it("an explicit org selection is never hosted, even for a hosted catalog id", () => {
    const definition = swarmTargetModelDefinition({
      modelId: "anthropic/claude-haiku-4.5",
      hosted: true,
      resolvedSelection: {
        modelId: "anthropic/claude-haiku-4.5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_1" },
        fallback: none,
      },
    });
    expect(definition.hosted).toBe(false);
  });

  it("a hosted selection is marked hosted", () => {
    expect(
      swarmTargetModelDefinition({
        modelId: "anthropic/claude-haiku-4.5",
        resolvedSelection: {
          modelId: "anthropic/claude-haiku-4.5",
          source: "hosted",
          fallback: none,
        },
      }).hosted,
    ).toBe(true);
  });

  it("a local selection runs its native id on its own provider", () => {
    expect(
      swarmTargetModelDefinition({
        modelId: "openai/gpt-4o",
        resolvedSelection: {
          modelId: "openai/gpt-4o",
          source: "local",
          connectionRef: { kind: "localProvider", providerKey: "openai" },
          nativeModelId: "gpt-4o",
          fallback: none,
        },
      }),
    ).toMatchObject({ id: "gpt-4o", provider: "openai", hosted: false });
  });

  it("a selection that disagrees with the pinned id, or is invalid, reads as legacy", () => {
    expect(
      swarmTargetModelDefinition({
        modelId: "anthropic/claude-haiku-4.5",
        hosted: true,
        resolvedSelection: {
          modelId: "openai/gpt-4o",
          source: "org",
          connectionRef: { kind: "orgProvider", id: "orgprov_1" },
          fallback: none,
        },
      }).hosted,
    ).toBe(true);
    expect(
      swarmTargetModelDefinition({
        modelId: "anthropic/claude-haiku-4.5",
        hosted: true,
        resolvedSelection: {
          modelId: "anthropic/claude-haiku-4.5",
          apiKey: "x",
        },
      }).hosted,
    ).toBe(true);
  });
});
