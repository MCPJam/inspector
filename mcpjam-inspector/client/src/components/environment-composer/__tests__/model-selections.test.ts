import { describe, expect, it, vi } from "vitest";
import type { ModelSelection as SavedModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  resolveComposerEnvironments,
  type EnsureAdhocEnvironmentsFn,
} from "../resolve-stacks";
import {
  composerStateFromEnvironments,
  emptyEnvironmentStack,
  environmentsExceedOneStack,
  expandModelChoices,
  parseStoredModelSelection,
  sameModelSelection,
  stackFromEnvironment,
  syncExplicitTargets,
  type EnvironmentComposerState,
} from "../environment-stack";

const SAME_ID = "anthropic/claude-haiku-4.5";
const hostedRow: ModelDefinition = {
  id: SAME_ID,
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
};
const orgRow: ModelDefinition = {
  id: SAME_ID,
  name: SAME_ID,
  provider: "openrouter",
  hosted: false,
  orgProvider: { providerKey: "openrouter", id: "orgprov_1" },
};
const ORG: SavedModelSelection = {
  modelId: SAME_ID,
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_1" },
  fallback: { provider: "none", model: "none" },
};
const HOSTED: SavedModelSelection = {
  modelId: SAME_ID,
  source: "hosted",
  fallback: { provider: "none", model: "none" },
};

function env(
  overrides: Partial<ProjectEnvironmentView> & { environmentId: string },
): ProjectEnvironmentView {
  return {
    projectId: "proj-1",
    hostId: "h1",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ProjectEnvironmentView;
}

function composeState(
  stack: Partial<EnvironmentComposerState["stack"]>,
): EnvironmentComposerState {
  return {
    environmentIds: [],
    stack: { ...emptyEnvironmentStack(), ...stack },
    customized: true,
  };
}

function ensureReturning(ids: string[]): EnsureAdhocEnvironmentsFn {
  return vi.fn(async () =>
    ids.map((environmentId) => ({
      environment: env({ environmentId }),
      created: true,
    })),
  );
}

const base = {
  projectId: "proj-1",
  skillsEnabled: true,
  computersEnabled: true,
  max: 10,
  modelMatrixEnabled: true,
};

const withEffort = (
  selection: SavedModelSelection,
  effort: "low" | "high",
): SavedModelSelection => ({
  ...selection,
  settings: { reasoningEffort: effort },
});

describe("syncExplicitTargets", () => {
  it("saves the row the user picked, not the first row with that id", () => {
    const next = syncExplicitTargets(
      { includeClientDefaults: false, explicitTargets: [{ modelId: SAME_ID }] },
      { models: [hostedRow, orgRow], picked: orgRow },
    );
    expect(next.explicitTargets).toEqual([{ modelId: SAME_ID, selection: ORG }]);
  });

  it("keeps a saved selection across unrelated edits and drops removed targets", () => {
    const previous = {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: SAME_ID, selection: ORG }],
    };
    const kept = syncExplicitTargets(
      { ...previous, includeClientDefaults: true },
      { models: [hostedRow, orgRow] },
    );
    expect(kept.explicitTargets).toEqual([{ modelId: SAME_ID, selection: ORG }]);
    const removed = syncExplicitTargets(
      { includeClientDefaults: true, explicitTargets: [] },
      { models: [hostedRow, orgRow] },
    );
    expect(removed).toEqual({ includeClientDefaults: true, explicitTargets: [] });
  });

  it("a checkbox pick by id takes the first listed row (hosted-first)", () => {
    const next = syncExplicitTargets(
      { includeClientDefaults: false, explicitTargets: [{ modelId: SAME_ID }] },
      { models: [hostedRow, orgRow] },
    );
    expect(next.explicitTargets[0]?.selection?.source).toBe("hosted");
  });

  it("keeps two efforts of one model as two targets, and dedupes the same key", () => {
    const low = { modelId: SAME_ID, selection: withEffort(HOSTED, "low") };
    const high = { modelId: SAME_ID, selection: withEffort(HOSTED, "high") };
    const next = syncExplicitTargets(
      { includeClientDefaults: false, explicitTargets: [low, high, { ...low }] },
      { models: [hostedRow] },
    );
    expect(next.explicitTargets).toEqual([low, high]);
  });

  it("a bare id and its plain hosted selection are one target (same comparisonKey)", () => {
    const next = syncExplicitTargets(
      {
        includeClientDefaults: false,
        explicitTargets: [{ modelId: SAME_ID, selection: HOSTED }, { modelId: SAME_ID }],
      },
      { models: [hostedRow] },
    );
    expect(next.explicitTargets).toEqual([{ modelId: SAME_ID, selection: HOSTED }]);
  });

  it("selections take part in equality and expansion", () => {
    const org = {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: SAME_ID, selection: ORG }],
    };
    const hosted = {
      ...org,
      explicitTargets: [{ modelId: SAME_ID, selection: HOSTED }],
    };
    expect(sameModelSelection(org, hosted)).toBe(false);
    expect(sameModelSelection(org, { ...org })).toBe(true);
    // An effort-only difference is a different composition.
    const at = (effort: "low" | "high") => ({
      ...org,
      explicitTargets: [{ modelId: SAME_ID, selection: withEffort(ORG, effort) }],
    });
    expect(sameModelSelection(at("low"), at("high"))).toBe(false);
    expect(sameModelSelection(at("low"), at("low"))).toBe(true);
    expect(expandModelChoices(org)).toEqual({
      cells: [{ modelId: SAME_ID, modelSelection: ORG }],
      skipped: [],
    });
  });

  it("expands two efforts of one model into two cells", () => {
    const low = withEffort(HOSTED, "low");
    const high = withEffort(HOSTED, "high");
    expect(
      expandModelChoices({
        includeClientDefaults: false,
        explicitTargets: [
          { modelId: SAME_ID, selection: low },
          { modelId: SAME_ID, selection: high },
        ],
      }).cells,
    ).toEqual([
      { modelId: SAME_ID, modelSelection: low },
      { modelId: SAME_ID, modelSelection: high },
    ]);
  });

  it("an environment's stored selection seeds the stack", () => {
    expect(
      stackFromEnvironment(
        env({ environmentId: "e1", modelId: SAME_ID, modelSelection: ORG }),
      ).modelSelection.explicitTargets,
    ).toEqual([{ modelId: SAME_ID, selection: ORG }]);
  });

  it("reconstructs one target per comparisonKey from attached environments", () => {
    const low = withEffort(HOSTED, "low");
    const high = withEffort(HOSTED, "high");
    const state = composerStateFromEnvironments(
      [
        env({ environmentId: "lo", modelId: SAME_ID, modelSelection: low }),
        env({ environmentId: "hi", modelId: SAME_ID, modelSelection: high }),
      ],
      { skillsEnabled: true, computersEnabled: true, modelsEnabled: true },
    );
    expect(state.stack.modelSelection.includeClientDefaults).toBe(false);
    expect(
      state.stack.modelSelection.explicitTargets.map(
        (target) => target.selection?.settings?.reasoningEffort,
      ),
    ).toEqual(expect.arrayContaining(["low", "high"]));
    expect(state.stack.modelSelection.explicitTargets).toHaveLength(2);
  });

  it("two efforts of one model on one client still round-trip through a stack", () => {
    const enabled = {
      skillsEnabled: true,
      computersEnabled: true,
      modelsEnabled: true,
    };
    const low = env({
      environmentId: "lo",
      modelId: SAME_ID,
      modelSelection: withEffort(HOSTED, "low"),
    });
    const high = env({
      environmentId: "hi",
      modelId: SAME_ID,
      modelSelection: withEffort(HOSTED, "high"),
    });
    expect(environmentsExceedOneStack([low, high], enabled)).toBe(false);
    // The same target twice still collapses.
    expect(
      environmentsExceedOneStack(
        [low, { ...low, environmentId: "lo-2" }],
        enabled,
      ),
    ).toBe(true);
  });

  it("reads a selection stored in the older parallel-id shape", () => {
    expect(
      parseStoredModelSelection({
        includeClientDefaults: false,
        explicitModelIds: [SAME_ID, "openai/gpt-5"],
        explicitModelSelections: { [SAME_ID]: ORG },
      }),
    ).toEqual({
      includeClientDefaults: false,
      explicitTargets: [
        { modelId: SAME_ID, selection: ORG },
        { modelId: "openai/gpt-5" },
      ],
    });
    expect(parseStoredModelSelection({ explicitModelIds: [] })).toBeUndefined();
  });
});

describe("resolveComposerEnvironments — saved selections", () => {
  const state = composeState({
    hostIds: ["h1"],
    modelSelection: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: SAME_ID, selection: ORG }],
    },
  });

  it("mints the cell with its selection when the backend stores selections", async () => {
    const ensure = ensureReturning(["a"]);
    await resolveComposerEnvironments({
      ...base,
      modelSelectionsEnabled: true,
      state,
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1", modelId: SAME_ID, modelSelection: ORG }],
    });
  });

  it("sends the legacy id alone to a backend without the capability", async () => {
    const ensure = ensureReturning(["a"]);
    await resolveComposerEnvironments({
      ...base,
      state,
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1", modelId: SAME_ID }],
    });
  });

  it("does not reuse a named row that runs the same id on another source", async () => {
    const ensure = ensureReturning(["minted"]);
    const result = await resolveComposerEnvironments({
      ...base,
      modelSelectionsEnabled: true,
      state,
      liveEnvironments: [
        env({
          environmentId: "hosted-named",
          name: "Prod",
          origin: "named",
          modelId: SAME_ID,
          modelSelection: HOSTED,
        } as Partial<ProjectEnvironmentView> & { environmentId: string }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(result.environmentIds).toEqual(["minted"]);
  });

  it("mints two efforts of one model as two environments", async () => {
    const low = withEffort(HOSTED, "low");
    const high = withEffort(HOSTED, "high");
    const ensure = ensureReturning(["lo", "hi"]);
    const result = await resolveComposerEnvironments({
      ...base,
      modelSelectionsEnabled: true,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: false,
          explicitTargets: [
            { modelId: SAME_ID, selection: low },
            { modelId: SAME_ID, selection: high },
          ],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [
        { hostId: "h1", modelId: SAME_ID, modelSelection: low },
        { hostId: "h1", modelId: SAME_ID, modelSelection: high },
      ],
    });
    expect(result.environmentIds).toEqual(["lo", "hi"]);
  });

  it("reuses a named row only for the effort it runs", async () => {
    const low = withEffort(HOSTED, "low");
    const high = withEffort(HOSTED, "high");
    const ensure = ensureReturning(["minted-high"]);
    const result = await resolveComposerEnvironments({
      ...base,
      modelSelectionsEnabled: true,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: false,
          explicitTargets: [
            { modelId: SAME_ID, selection: low },
            { modelId: SAME_ID, selection: high },
          ],
        },
      }),
      liveEnvironments: [
        env({
          environmentId: "named-low",
          name: "Low",
          origin: "named",
          modelId: SAME_ID,
          modelSelection: low,
        } as Partial<ProjectEnvironmentView> & { environmentId: string }),
      ],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1", modelId: SAME_ID, modelSelection: high }],
    });
    expect(result.environmentIds).toEqual(["named-low", "minted-high"]);
  });

  it("without the selections capability two efforts of one model are one cell", async () => {
    const ensure = ensureReturning(["a"]);
    await resolveComposerEnvironments({
      ...base,
      state: composeState({
        hostIds: ["h1"],
        modelSelection: {
          includeClientDefaults: false,
          explicitTargets: [
            { modelId: SAME_ID, selection: withEffort(HOSTED, "low") },
            { modelId: SAME_ID, selection: withEffort(HOSTED, "high") },
          ],
        },
      }),
      liveEnvironments: [],
      ensureAdhocEnvironments: ensure,
    });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "h1", modelId: SAME_ID }],
    });
  });
});
