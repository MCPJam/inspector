import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

import { SUPPORTED_MODELS, type ModelDefinition } from "@/shared/types";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  composeAvailableModels,
  isOrgKeysDisallowedRow,
} from "@/components/chat-v2/shared/available-models";
import {
  buildAvailableModelsFromOrgConfig,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import { syncExplicitTargets } from "@/components/environment-composer/environment-stack";
import {
  preflightTargets,
  runPreflight,
} from "@/components/evaluate/suite-run-preflight";
import type { EvalSuite } from "@/components/evals/types";
import type { ModelTarget } from "@/lib/model-target";
import {
  evalModelRows,
  pickedModelTarget,
  resolveEvalModelChoice,
} from "../org-keys-model-target";

const openAi: OrgModelProvider = {
  id: "orgprov_openai",
  providerKey: "openai",
  enabled: true,
  hasSecret: true,
  policyEligibility: { eligible: true },
};
const xai: OrgModelProvider = {
  id: "orgprov_xai",
  providerKey: "xai",
  enabled: true,
  hasSecret: true,
  policyEligibility: { eligible: true },
};
const bedrock: OrgModelProvider = {
  id: "orgprov_bedrock",
  providerKey: "bedrock",
  enabled: true,
  hasSecret: true,
  selectedModels: ["anthropic.claude-sonnet-4-5-20250929-v1:0"],
  policyEligibility: { eligible: true },
};
const policy = (providers: OrgModelProvider[]): OrgVisibleConfig => ({
  providers,
  aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
});
const orgConfig = policy([openAi]);

/** The org-only list a suite editor shows, with its saved ids kept. */
function pickerRows(
  savedModelIds: string[] = [],
  config: OrgVisibleConfig = orgConfig,
): ModelDefinition[] {
  const models = composeAvailableModels({
    orgConfig: config,
    isAuthenticated: true,
    isOllamaRunning: false,
    ollamaModels: [],
    hasToken: () => false,
    getOpenRouterSelectedModels: () => [],
    getAzureBaseUrl: () => "",
    customProviders: [],
    hostedCatalog: [],
    savedModelIds,
  });
  return evalModelRows(models, null, true);
}

/** Pick `row` in the suite editor: the target list the suite saves. */
function pick(row: ModelDefinition, rows: ModelDefinition[]): ModelTarget[] {
  const next = syncExplicitTargets(
    {
      includeClientDefaults: false,
      explicitTargets: [pickedModelTarget(row, true)],
    },
    { models: rows, picked: row },
  );
  return next.explicitTargets;
}

/** Save → reload: what comes back from storage. */
const reload = (targets: ModelTarget[]): ModelTarget[] =>
  JSON.parse(JSON.stringify(targets)) as ModelTarget[];

const suite = {
  _id: "suite",
  createdBy: "user",
  name: "QA suite",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  environmentIds: ["env"],
  createdAt: 0,
  updatedAt: 0,
} satisfies EvalSuite;

/** Setup Run's org-key verdict for the saved target. */
function setupRunProblems(
  target: ModelTarget,
  config: OrgVisibleConfig = orgConfig,
): string[] | undefined {
  const plan = preflightTargets({
    suite,
    cases: [],
    environments: [{ environmentId: "env", hostId: "client", modelId: null }],
    hosts: [{ hostId: "client", modelId: "openai/gpt-5" }],
    environmentServerRefs: [],
    targets: [
      {
        hostId: "client",
        modelId: target.modelId,
        ...(target.selection ? { modelSelection: target.selection } : {}),
      },
    ],
  });
  return runPreflight({ ...plan, servers: {}, orgConfig: config })
    .orgKeyProblems;
}

describe("GPT-5.1 from the organization eval picker", () => {
  it("saves openai/gpt-5.1 with its org connection and launches", () => {
    const rows = pickerRows();
    const row = rows.find((model) => String(model.id) === "gpt-5.1");
    expect(row).toBeDefined();

    const [saved] = reload(pick(row!, rows));
    expect(saved).toEqual({
      modelId: "openai/gpt-5.1",
      selection: expect.objectContaining({
        modelId: "openai/gpt-5.1",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_openai" },
        nativeModelId: "gpt-5.1",
      }),
    });

    // Reopening the suite resolves the same row, not "isn't allowed here".
    const reopened = resolveEvalModelChoice(
      saved.modelId,
      pickerRows([saved.modelId]),
      true,
      { selection: saved.selection },
    );
    expect(isOrgKeysDisallowedRow(reopened)).toBe(false);
    expect(String(reopened.id)).toBe("gpt-5.1");

    expect(setupRunProblems(saved)).toBeUndefined();
  });

  it("repairs a suite that saved the bare id when GPT-5.1 is picked again", () => {
    const bad: ModelTarget = { modelId: "gpt-5.1" };
    const rows = pickerRows([bad.modelId]);
    expect(
      isOrgKeysDisallowedRow(
        resolveEvalModelChoice(bad.modelId, rows, true, {}),
      ),
    ).toBe(true);
    // Blocked: a target saved without an org selection can't launch.
    expect(setupRunProblems(bad)).toHaveLength(1);

    const row = rows.find(
      (model) => String(model.id) === "gpt-5.1" && !model.disabled,
    )!;
    const [repaired] = reload(pick(row, rows));
    expect(repaired.selection?.source).toBe("org");
    expect(setupRunProblems(repaired)).toBeUndefined();
  });
});

describe("models an organization defines", () => {
  it("saves a Bedrock model with its connection and launches it", () => {
    const config = policy([bedrock]);
    const rows = pickerRows([], config);
    const row = rows.find((model) => model.provider === "bedrock")!;
    const [saved] = reload(pick(row, rows));
    expect(saved.selection).toMatchObject({
      modelId: "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_bedrock" },
      nativeModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    expect(setupRunProblems(saved, config)).toBeUndefined();
  });

  it("finds a saved choice after its canonical id changes", () => {
    // Saved while grok-4.5 derived to x-ai/grok-4.5; the catalog now spells
    // it spacexai/grok-4.5. Same connection, same native id: same model.
    const config = policy([xai]);
    const saved = {
      modelId: "x-ai/grok-4.5",
      source: "org" as const,
      connectionRef: { kind: "orgProvider" as const, id: "orgprov_xai" },
      nativeModelId: "grok-4.5",
      fallback: { provider: "none" as const, model: "none" as const },
    };
    const reopened = resolveEvalModelChoice(
      saved.modelId,
      pickerRows([saved.modelId], config),
      true,
      { selection: saved },
    );
    expect(isOrgKeysDisallowedRow(reopened)).toBe(false);
    expect(String(reopened.id)).toBe("grok-4.5");
  });
});

describe("evalModelRows", () => {
  it("offers only rows a pick saves with an org connection", () => {
    // A connection from a backend that sends no connection id can't be named
    // in a selection, so a pick would save a legacy id the launch refuses.
    const { id: _id, ...noId } = openAi;
    const models = buildAvailableModelsFromOrgConfig(policy([noId]), []);
    const openAiRow = (rows: ModelDefinition[]) =>
      rows.some((model) => model.provider === "openai");
    expect(openAiRow(models)).toBe(true);
    expect(openAiRow(evalModelRows(models, null, true))).toBe(false);
    expect(openAiRow(evalModelRows(models, null, false))).toBe(true);
  });

  it("keeps a saved model the policy refuses, so its trigger can say so", () => {
    const rows = pickerRows(["anthropic/claude-haiku-4.5"]);
    expect(
      rows.some(
        (model) =>
          String(model.id) === "anthropic/claude-haiku-4.5" &&
          isOrgKeysDisallowedRow(model),
      ),
    ).toBe(true);
  });

  it("offers every SUPPORTED_MODELS row an org connection serves", () => {
    // Fails when a new SUPPORTED_MODELS row can't form a canonical id
    // (`canonicalModelIdForNative` in shared/canonical-model-id.ts), which
    // the org picker would silently drop.
    for (const model of SUPPORTED_MODELS) {
      const provider = String(model.provider);
      const row: ModelDefinition = {
        ...model,
        hosted: false,
        orgProvider: { providerKey: provider, id: `orgprov_${provider}` },
      };
      expect(
        evalModelRows([row], null, true),
        `${provider} ${String(model.id)}`,
      ).toHaveLength(1);
      expect(pickedModelTarget(row, true).modelId).toMatch(/^[a-z-]+\//);
    }
  });
});
