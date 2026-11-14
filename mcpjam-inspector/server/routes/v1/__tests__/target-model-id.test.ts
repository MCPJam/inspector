import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalTargetModelEntry,
  canonicalTargetModelId,
} from "../target-model-id.js";
import {
  __resetHostedModelCatalogForTests,
  ingestHostedCatalogIds,
} from "../../../services/hosted-model-catalog.js";

// PLB-188: a suite file's case model written `mcpjam/anthropic/claude-haiku-4.5`
// ran locally (the SDK's `planModel` strips the prefix) but a hosted run stored
// it with provider `mcpjam`, matched nothing in the hosted catalog, and sent
// every case down the BYOK path. The route tests live with the routes
// (`eval-case-vocabulary-2-cli-body.test.ts`, `judge-model-from-file.test.ts`).
//
// Made-up ids, ingested into the DYNAMIC catalog for each test, as in
// `judge-model-id.test.ts`.
const HAIKU = "anthropic/target-fixture-haiku-9.9";
const GROK = "x-ai/target-fixture-grok-9.9";

beforeEach(() => {
  __resetHostedModelCatalogForTests();
  ingestHostedCatalogIds([HAIKU, GROK]);
});

afterEach(() => {
  __resetHostedModelCatalogForTests();
});

describe("canonicalTargetModelEntry", () => {
  it.each([undefined, "mcpjam", "anthropic", "Anthropic", " mcpjam "])(
    "stores a mcpjam/ target as the hosted pick it names (provider %j)",
    (provider) => {
      expect(
        canonicalTargetModelEntry({
          model: `mcpjam/${HAIKU}`,
          ...(provider === undefined ? {} : { provider }),
        }),
      ).toEqual({ model: HAIKU, provider: "anthropic" });
    },
  );

  it.each(["x-ai", "xai", undefined])(
    "uses the provider key, not the id's prefix, for a renamed vendor (hint %j)",
    (provider) => {
      expect(
        canonicalTargetModelEntry({ model: `mcpjam/${GROK}`, provider }),
      ).toEqual({ model: GROK, provider: "xai" });
    },
  );

  it("keeps a hosted selection and the entry's other fields", () => {
    const selection = { source: "hosted", modelId: HAIKU };
    expect(
      canonicalTargetModelEntry({
        model: `mcpjam/${HAIKU}`,
        selection,
      }),
    ).toEqual({ model: HAIKU, provider: "anthropic", selection });
  });

  it.each([
    // BYOK and already-canonical ids are never touched.
    { model: HAIKU, provider: "anthropic" },
    { model: "gpt-4o", provider: "openai" },
    // A provider that contradicts the vendor, as `planModel` refuses it.
    { model: `mcpjam/${HAIKU}`, provider: "openai" },
    // A non-hosted selection decides the rail; the prefix contradicts it.
    { model: `mcpjam/${HAIKU}`, selection: { source: "org" } },
    // Not exactly a hosted catalog id.
    { model: "mcpjam/anthropic/target-fixture-haiku-9-9" },
    { model: `mcpjam/mcpjam/${HAIKU}` },
    { model: `mcpjam/ ${HAIKU}` },
    { model: `MCPJam/${HAIKU}` },
    { model: "mcpjam/anthropic/not-in-the-catalog" },
    { model: "mcpjam/target-fixture-haiku-9.9" },
  ])("leaves %j exactly as sent", (entry) => {
    expect(canonicalTargetModelEntry(entry)).toBe(entry);
  });

  it("forwards a model the catalog does not know yet as typed", () => {
    __resetHostedModelCatalogForTests();
    const entry = { model: `mcpjam/${HAIKU}` };
    expect(canonicalTargetModelEntry(entry)).toBe(entry);
  });
});

describe("canonicalTargetModelId", () => {
  it("drops the prefix from a hosted catalog id", () => {
    expect(canonicalTargetModelId(`mcpjam/${HAIKU}`)).toBe(HAIKU);
  });

  it.each([HAIKU, "gpt-4o", "mcpjam/anthropic/not-in-the-catalog"])(
    "returns %j as sent",
    (id) => {
      expect(canonicalTargetModelId(id)).toBe(id);
    },
  );
});
