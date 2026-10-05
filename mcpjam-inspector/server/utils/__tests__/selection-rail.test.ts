/**
 * EXECUTION-READER GUARD: routing reads the saved selection, and a row with
 * no selection routes exactly as it did before selections existed.
 *
 * Two properties, pinned separately because they fail differently:
 *
 *  1. The table — {no selection, hosted, org, local, stored legacy} → rail —
 *     through the pure decision AND through the resolver the synthetic, swarm
 *     and v1 session surfaces call (`resolveSyntheticModelSource`). A stored
 *     legacy selection ("own key only") never reaches the hosted rail, however
 *     hosted its id looks.
 *  2. Byte-identity for unlabelled rows: for a matrix of bare ids, the new
 *     decision with no selection equals TODAY's function — the hosted-list
 *     check `isHostedModelDefinition`, called directly here rather than
 *     through any wrapper this change added.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestedModelSelection } from "@mcpjam/sdk";
import {
  MCPJAM_PROVIDED_MODEL_IDS,
  type ModelDefinition,
} from "@/shared/types";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
  isHostedModelDefinition,
} from "../../services/hosted-model-catalog.js";
import {
  decideTurnRail,
  forwardableSelection,
  readRoutingSelection,
  readSelectionOrigin,
  readStoredLegacySelection,
  routingSelectionForModel,
  todayTurnRail,
  withSelectionRouting,
} from "../selection-rail.js";
import { resolveSyntheticModelSource } from "../org-model-config.js";

const none = { provider: "none", model: "none" } as const;
const HOSTED_ID = MCPJAM_PROVIDED_MODEL_IDS[0]!;

const selections = (modelId: string) =>
  ({
    hosted: { modelId, source: "hosted", fallback: none },
    org: {
      modelId,
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_1" },
      fallback: none,
    },
    local: {
      modelId,
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "anthropic" },
      fallback: none,
    },
    legacy: { source: "legacy", modelId },
  }) satisfies Record<string, RequestedModelSelection>;

beforeEach(() => {
  __resetHostedModelCatalogForTests();
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
});

afterEach(() => {
  __resetHostedModelCatalogForTests();
  vi.unstubAllEnvs();
});

describe("decideTurnRail — the routing table", () => {
  const hostedModel: ModelDefinition = {
    id: HOSTED_ID,
    name: HOSTED_ID,
    provider: "anthropic",
  };

  it.each([
    ["no selection, hosted id", undefined, "hosted"],
    ["hosted", "hosted", "hosted"],
    ["org", "org", "org"],
    ["local", "local", "local"],
    ["stored legacy", "legacy", "own-key"],
  ] as const)("%s → %s", (_label, source, rail) => {
    const selection = source ? selections(HOSTED_ID)[source] : undefined;
    expect(decideTurnRail({ selection, model: hostedModel })).toBe(rail);
  });

  it("no selection on a non-hosted id is today's own-key path", () => {
    expect(
      decideTurnRail({
        model: { id: "claude-3-5-sonnet-latest", provider: "anthropic" },
      }),
    ).toBe("own-key");
  });

  it("a hosted selection decides even where the hosted list would not (the backend admits it)", () => {
    expect(
      decideTurnRail({
        selection: selections("vendor/brand-new-model").hosted,
        model: { id: "vendor/brand-new-model", provider: "vendor" },
      }),
    ).toBe("hosted");
  });
});

describe("resolveSyntheticModelSource reads the selection (synthetic, swarm, v1 sessions)", () => {
  const model: ModelDefinition = {
    id: HOSTED_ID,
    name: HOSTED_ID,
    provider: "anthropic",
  };

  it.each([
    ["no selection", undefined, "mcpjam"],
    ["hosted", "hosted", "mcpjam"],
    ["org", "org", "byok"],
    ["local", "local", "byok"],
    ["stored legacy", "legacy", "byok"],
  ] as const)("%s on a hosted id → %s", async (_label, source, expected) => {
    const resolution = await resolveSyntheticModelSource({
      modelDefinition: model,
      projectId: "proj-1",
      ...(source ? { modelSelection: selections(HOSTED_ID)[source] } : {}),
    });
    expect(resolution.source).toBe(expected);
    if (expected === "byok") {
      // The own-key / org path, on the provider's cloud connection: never
      // MCPJam credits.
      expect(resolution.orgRuntime).toEqual({
        runtimeLocation: "cloud",
        providerKey: "anthropic",
      });
    }
  });
});

describe("unlabelled rows route byte-identically to today", () => {
  const MATRIX: Array<{
    id: string;
    provider?: string;
    hosted?: boolean;
  }> = [
    ...MCPJAM_PROVIDED_MODEL_IDS.slice(0, 12).map((id) => ({ id })),
    ...MCPJAM_PROVIDED_MODEL_IDS.slice(0, 6).map((id) => ({
      id,
      provider: id.split("/")[0],
    })),
    // Bare hosted twins: canonicalize to the prefixed hosted id with their
    // provider (or not, when the twin is gone) — today's answer either way.
    { id: "gpt-5-nano", provider: "openai" },
    { id: "claude-fable-5", provider: "anthropic" },
    { id: "gemini-2.5-pro", provider: "google" },
    // The picker's own-provider stamp moves a hosted id OFF credits.
    { id: HOSTED_ID, provider: "anthropic", hosted: false },
    { id: HOSTED_ID, hosted: true },
    // Plain BYOK, custom, local and sentinel ids.
    { id: "claude-3-5-sonnet-latest", provider: "anthropic" },
    { id: "gpt-4o", provider: "openai" },
    { id: "custom:acme:my-model", provider: "custom" },
    { id: "llama3", provider: "ollama" },
    { id: "anthropic.claude-3-5-sonnet-20240620-v1:0", provider: "bedrock" },
    { id: "cursor/auto", provider: "cursor" },
    { id: "vendor/unknown-model" },
    { id: "" },
  ];

  it.each(MATRIX)("decision for %o equals isHostedModelDefinition", (model) => {
    const today = isHostedModelDefinition(model) ? "hosted" : "own-key";
    expect(decideTurnRail({ model })).toBe(today);
    expect(decideTurnRail({ selection: undefined, model })).toBe(today);
    expect(todayTurnRail(model)).toBe(today);
  });

  it("follows the live hosted catalog exactly as today does", () => {
    const fresh = { id: "vendor/added-after-snapshot" };
    expect(decideTurnRail({ model: fresh })).toBe("own-key");
    __setHostedCatalogForTests(["vendor/added-after-snapshot"]);
    expect(isHostedModelDefinition(fresh)).toBe(true);
    expect(decideTurnRail({ model: fresh })).toBe("hosted");
  });

  it("a stored legacy selection is never hosted, for any id in the matrix", () => {
    for (const model of MATRIX) {
      if (!model.id) continue;
      expect(
        decideTurnRail({
          selection: { source: "legacy", modelId: model.id },
          model,
        }),
      ).toBe("own-key");
    }
  });

  it("an unlabelled synthetic resolution matches today's hosted-list answer", async () => {
    for (const model of MATRIX) {
      if (!model.id || model.id === "cursor/auto") continue;
      if (!isHostedModelDefinition(model)) continue;
      const resolution = await resolveSyntheticModelSource({
        modelDefinition: { name: model.id, provider: "anthropic", ...model },
        projectId: "proj-1",
      });
      expect(resolution.source).toBe("mcpjam");
    }
  });
});

describe("reading a stored selection", () => {
  it("reads a full selection through the SDK validator", () => {
    const hosted = selections(HOSTED_ID).hosted;
    expect(readRoutingSelection(hosted)).toEqual(hosted);
  });

  it("reads a stored legacy selection, with or without its provider hint", () => {
    expect(
      readRoutingSelection({ source: "legacy", modelId: "llama3" }),
    ).toEqual({ source: "legacy", modelId: "llama3" });
    expect(
      readStoredLegacySelection({
        source: "legacy",
        modelId: "gpt-5.1",
        provider: "azure",
      }),
    ).toEqual({ source: "legacy", modelId: "gpt-5.1", provider: "azure" });
  });

  it.each([
    [undefined],
    [null],
    ["openai/gpt-5"],
    [{ source: "legacy" }],
    [{ source: "legacy", modelId: "  " }],
    [{ source: "legacy", modelId: "x", apiKey: "sk-secret" }],
    [{ source: "legacy", modelId: "x", provider: 7 }],
    [{ modelId: "openai/gpt-5", source: "hosted" }],
  ])("reads %o as no selection (today's path)", (value) => {
    expect(readRoutingSelection(value)).toBeUndefined();
  });

  it("reads only the backfill marker", () => {
    expect(readSelectionOrigin("backfill")).toBe("backfill");
    expect(readSelectionOrigin("user")).toBeUndefined();
    expect(readSelectionOrigin(undefined)).toBeUndefined();
  });
});

describe("a selection applies only to its own model", () => {
  it("matches the raw id or its canonical form, never another model", () => {
    const legacy = { source: "legacy" as const, modelId: "llama3" };
    expect(routingSelectionForModel(legacy, { id: "llama3" })).toBe(legacy);
    expect(
      routingSelectionForModel(legacy, { id: "llama3.1" }),
    ).toBeUndefined();
    const hosted = selections(HOSTED_ID).hosted;
    expect(routingSelectionForModel(hosted, { id: ` ${HOSTED_ID} ` })).toBe(
      hosted,
    );
    expect(
      routingSelectionForModel(undefined, { id: HOSTED_ID }),
    ).toBeUndefined();
  });
});

describe("withSelectionRouting / forwardableSelection", () => {
  const model: ModelDefinition = {
    id: HOSTED_ID,
    name: HOSTED_ID,
    provider: "anthropic",
  };

  it("stamps hosted:false for every non-hosted selection, and nothing otherwise", () => {
    const all = selections(HOSTED_ID);
    for (const source of ["org", "local", "legacy"] as const) {
      const routed = withSelectionRouting(model, all[source]);
      expect(routed.hosted).toBe(false);
      expect(isHostedModelDefinition(routed)).toBe(false);
    }
    expect(withSelectionRouting(model, all.hosted)).toBe(model);
    expect(withSelectionRouting(model, undefined)).toBe(model);
  });

  it("forwards only hosted and org selections to the backend", () => {
    const all = selections(HOSTED_ID);
    expect(forwardableSelection(all.hosted)).toBe(all.hosted);
    expect(forwardableSelection(all.org)).toBe(all.org);
    expect(forwardableSelection(all.local)).toBeUndefined();
    expect(forwardableSelection(all.legacy)).toBeUndefined();
    expect(forwardableSelection(undefined)).toBeUndefined();
  });
});
