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
  harnessTurnRail,
  readRoutingSelection,
  readSelectionOrigin,
  readStoredLegacySelection,
  routingSelectionForModel,
  resolveChatSelection,
  streamSelectionFields,
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

describe("harnessTurnRail — one decision for both chat routes", () => {
  const orgSel = selections("anthropic/claude-sonnet-4.5").org;
  const anthropicRow = {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    hosted: false,
  };
  const rail = (
    harness: string | undefined,
    overrides: Partial<Parameters<typeof harnessTurnRail>[0]> = {},
  ) =>
    harnessTurnRail({
      harness,
      model: anthropicRow,
      selection: orgSel,
      mcpjamProvided: false,
      stepUpResume: false,
      ...overrides,
    });

  it("an org connection on the harness's vendor runs the harness on the org's key", () => {
    expect(rail("claude-code")).toEqual({
      externalAccount: false,
      orgSelection: orgSel,
      orgStepUpResume: false,
      usesFreePath: true,
      modelSource: "byok",
    });
  });

  it("a step-up resume on that turn leaves the free path and stays the org's spend", () => {
    expect(rail("claude-code", { stepUpResume: true })).toMatchObject({
      orgStepUpResume: true,
      usesFreePath: false,
      modelSource: "byok",
    });
  });

  it("an org connection on another vendor is not an org-key harness turn", () => {
    expect(rail("codex")).toMatchObject({
      orgSelection: undefined,
      usesFreePath: false,
      modelSource: "mcpjam",
    });
  });

  it("an org selection without an org connection is not narrowed", () => {
    const { connectionRef: _dropped, ...unbound } = orgSel;
    expect(
      rail("claude-code", { selection: unbound as RequestedModelSelection }),
    ).toMatchObject({ orgSelection: undefined, modelSource: "mcpjam" });
  });

  it("an external-account harness pays on the customer's account, whatever the selection", () => {
    expect(rail("cursor")).toEqual({
      externalAccount: true,
      orgSelection: undefined,
      orgStepUpResume: false,
      usesFreePath: true,
      modelSource: "external-account",
    });
  });

  it("without a harness only an MCPJam-provided model takes the free path", () => {
    expect(rail(undefined).usesFreePath).toBe(false);
    expect(rail(undefined, { mcpjamProvided: true })).toMatchObject({
      usesFreePath: true,
      modelSource: "mcpjam",
    });
  });
});


describe("explicit chat selections", () => {
  const model = { id: "openai/gpt-5-mini", provider: "openai" };
  const inherited = selections(model.id).org;
  const resolve = (raw: unknown, overrides = {}) => resolveChatSelection({
    raw, inherited, model, hostWins: false, allowLocal: true, ...overrides,
  });
  it.each([undefined, null])("preserves absent-selection compatibility: %s", (raw) => {
    expect(resolve(raw)).toEqual({ ok: true, selection: inherited });
  });
  it.each([{}, false, "openai/gpt-5-mini", { ...inherited, apiKey: "forbidden" },
    { ...inherited, modelId: "other/model" }])("refuses explicit invalid/mismatched input: %j", (raw) => {
    expect(resolve(raw).ok).toBe(false);
  });
  it("a scenario ignores even malformed visitor input", () => {
    expect(resolve({}, { hostWins: true })).toEqual({ ok: true, selection: inherited });
  });
  it.each(["local", "legacy"] as const)("web refuses explicit %s, MCP retains it", (source) => {
    const raw = source === "local"
      ? { ...selections(model.id).local, connectionRef: { kind: "localProvider", providerKey: "openai" } }
      : selections(model.id).legacy;
    expect(resolve(raw, { allowLocal: false }).ok).toBe(false);
    expect(resolve(raw)).toEqual({ ok: true, selection: raw, requestSelection: raw });
  });
  it("the explicit object overrides the host without rebinding its connection", () => {
    const raw = { ...inherited, connectionRef: { kind: "orgProvider", id: "other" } };
    expect(resolve(raw)).toEqual({ ok: true, selection: raw, requestSelection: raw });
  });
});

describe("native selection identity and stream fields", () => {
  const org = (modelId: string, nativeModelId?: string): RequestedModelSelection => ({
    modelId, source: "org", connectionRef: { kind: "orgProvider", id: "conn-1" },
    ...(nativeModelId ? { nativeModelId } : {}), fallback: none,
  });
  it.each([
    ["anthropic/claude-sonnet-4.5", "claude-sonnet-4-5", "anthropic"],
    ["ollama/llama3", "llama3", "ollama"],
    ["custom/my-model", "deployment", "custom"],
    ["azure/my-deployment", "my-deployment", "azure"],
  ])("matches %s by its native id and preserves the canonical selection", (canonical, native, provider) => {
    const selection = org(canonical, native);
    expect(routingSelectionForModel(selection, { id: native, provider })).toBe(selection);
    expect(streamSelectionFields(selection, { id: native, provider }, "/stream/org")).toEqual({
      model: native, modelSelection: selection, nativeModelId: undefined,
    });
  });
  it("refuses contradictory provider, native id and connection evidence", () => {
    const selection = org("anthropic/claude-sonnet-4.5", "claude-sonnet-4-5");
    for (const model of [
      { id: "claude-sonnet-4-5", provider: "openai" },
      { id: selection.modelId, nativeModelId: "other" },
      { id: selection.modelId, orgProvider: { providerKey: "anthropic", id: "other" } },
    ]) expect(routingSelectionForModel(selection, model)).toBeUndefined();
  });
  it("does not use a native alias to replace another canonical row", () => {
    const selection = org("anthropic/selected", "anthropic/other");
    expect(routingSelectionForModel(selection, { id: "anthropic/other", provider: "anthropic" })).toBeUndefined();
  });
  it("normalizes a hosted alias and keeps no-fallback, refusing a source mismatch", () => {
    const selection = selections("openai/gpt-5-mini").hosted;
    expect(streamSelectionFields(selection, { id: "gpt-5-mini", provider: "openai" }, "/stream")).toEqual({
      model: selection.modelId, modelSelection: selection, nativeModelId: undefined,
    });
    expect(() => streamSelectionFields(selection, { id: selection.modelId }, "/stream/org")).toThrow();
    expect(() => streamSelectionFields(selection, { id: "other/model" }, "/stream")).toThrow();
    expect(() => streamSelectionFields(selections(selection.modelId).local, { id: selection.modelId }, "/stream")).toThrow();
  });
});
