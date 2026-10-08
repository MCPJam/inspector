import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  MODEL_REASONING_EFFORTS,
  MODEL_SELECTION_FALLBACK_PROVIDERS,
  MODEL_SELECTION_SOURCES,
} from "@mcpjam/sdk/host-config/internal";
import { modelSelectionSchema } from "../model-selection-schema.js";

/**
 * The published `ModelSelection` must match what the routes accept.
 *
 * `docs/reference/openapi.json` is HAND-AUTHORED and `ModelSelection` has no
 * SDK interface twin for `openapi-types-parity` to pair, so nothing else
 * compares its enums to the validator every v1 write runs (`validateModelSelection`
 * via `modelSelectionSchema`). The effort union is the one that drifts: a level
 * added to the SDK and not to the spec makes a generated client refuse a value
 * the API accepts. Every place the spec spells the union is checked, not just
 * the schema, because a chat turn's `reasoningEffort` and the catalog's
 * `supportedReasoningEfforts` repeat it.
 *
 * Modeled on `openapi-harness-enum.test.ts`.
 */

type Schema = {
  enum?: unknown[];
  properties?: Record<string, Schema>;
  items?: Schema;
};

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(resolve(here, "../../../../../docs/reference/openapi.json"), "utf8"),
) as { components: { schemas: Record<string, Schema> } };

const schemas = spec.components.schemas;
const efforts = new Set<unknown>(MODEL_REASONING_EFFORTS);

describe("openapi.json ModelSelection ↔ the SDK's model selection contract", () => {
  const selection = schemas.ModelSelection;

  it("documents the schema at all", () => {
    // Guard the guard: a rename would make every assertion below vacuous.
    expect(selection, "ModelSelection is missing from the spec").toBeDefined();
  });

  it("lists exactly the reasoning efforts the validator accepts", () => {
    const documented = selection?.properties?.settings?.properties?.reasoningEffort;
    expect(documented?.enum, "settings.reasoningEffort has no enum").toBeDefined();
    expect(new Set(documented?.enum)).toEqual(efforts);
  });

  it("lists exactly the sources and fallback providers the validator accepts", () => {
    expect(new Set(selection?.properties?.source?.enum)).toEqual(
      new Set(MODEL_SELECTION_SOURCES),
    );
    expect(
      new Set(selection?.properties?.fallback?.properties?.provider?.enum),
    ).toEqual(new Set(MODEL_SELECTION_FALLBACK_PROVIDERS));
  });

  it("repeats the effort union identically on a chat turn and on the public catalog", () => {
    const turn = schemas.SendChatMessageRequest?.properties?.reasoningEffort;
    const catalog = schemas.CatalogModel?.properties?.supportedReasoningEfforts;
    expect(new Set(turn?.enum), "SendChatMessageRequest.reasoningEffort").toEqual(
      efforts,
    );
    expect(
      new Set(catalog?.items?.enum),
      "CatalogModel.supportedReasoningEfforts",
    ).toEqual(efforts);
  });

  it("accepts every documented effort through the route validator, and refuses one it does not list", () => {
    const base = {
      modelId: "openai/gpt-5",
      source: "hosted",
      fallback: { provider: "none", model: "none" },
    };
    for (const effort of MODEL_REASONING_EFFORTS) {
      expect(
        modelSelectionSchema.safeParse({ ...base, settings: { reasoningEffort: effort } })
          .success,
        effort,
      ).toBe(true);
    }
    expect(
      modelSelectionSchema.safeParse({ ...base, settings: { reasoningEffort: "turbo" } })
        .success,
    ).toBe(false);
  });
});
