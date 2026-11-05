import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import {
  hostConfigDtoToInput,
  type HostConfigDtoV2,
} from "../client-config-v2";
import { HOST_MODEL_SELECTION_PURPOSE } from "../host-model-selection";
import {
  orgCanonicalTarget,
  orgKeysSavableRows,
  pickedModelTarget,
} from "../org-keys-model-target";
import {
  carryEffortToModel,
  selectionReasoningEffort,
  setEffortForRow,
} from "../reasoning-effort-selection";

// Organization rows as the client editor lists them under the key policy:
// bare ids on the organization's own OpenAI and Anthropic connections.
const ORG_LUNA = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  hosted: false,
  orgProvider: { providerKey: "openai", id: "orgprov_openai" },
} as ModelDefinition;
const ORG_SONNET = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  hosted: false,
  supportedReasoningEfforts: ["low", "medium", "high"],
  orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
} as ModelDefinition;
const ORG_ROWS = [ORG_LUNA, ORG_SONNET];

const purpose = HOST_MODEL_SELECTION_PURPOSE;

/** What the backend hands back for a saved client, then the editor reads. */
function reload(saved: {
  modelId: string;
  selection?: HostConfigDtoV2["modelSelection"];
}) {
  const dto: HostConfigDtoV2 = {
    id: "host-qa",
    schemaVersion: 2,
    hostStyle: "chatgpt",
    modelId: saved.modelId,
    ...(saved.selection ? { modelSelection: saved.selection } : {}),
    systemPrompt: "",
    temperature: 0.7,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
  };
  return hostConfigDtoToInput(dto);
}

/** The row the client editor shows for a saved config under the policy. */
function editorRow(input: ReturnType<typeof reload>) {
  return findModelForStoredChoice(
    { modelId: input.modelId, selection: input.modelSelection },
    ORG_ROWS,
    undefined,
    { exactSelection: true },
  );
}

describe("client editor under the organization key policy (QA-26)", () => {
  it.each([ORG_LUNA, ORG_SONNET])(
    "a pick of $id saves the canonical id with its org connection",
    (row) => {
      const carried = carryEffortToModel({
        row,
        previousEffort: undefined,
        purpose,
        selectionsSupported: true,
      });
      expect(carried.modelId).toBe(`${row.provider}/${row.id}`);
      expect(carried.selection).toMatchObject({
        modelId: carried.modelId,
        source: "org",
        connectionRef: { kind: "orgProvider", id: row.orgProvider?.id },
        nativeModelId: row.id,
      });
    },
  );

  it("save and reload resolve to the picked row, not the disallowed warning", () => {
    for (const row of ORG_ROWS) {
      const carried = carryEffortToModel({
        row,
        previousEffort: undefined,
        purpose,
        selectionsSupported: true,
      });
      const input = reload({
        modelId: carried.modelId,
        selection: carried.selection,
      });
      expect(input.modelSelection).toEqual(carried.selection);
      expect(editorRow(input)).toBe(row);
    }
  });

  it("the bare id saved before this fix still reads as disallowed", () => {
    expect(editorRow(reload({ modelId: "gpt-5.6-luna" }))).toBeUndefined();
  });

  it("a pick that drops an effort the new model lacks still saves the org connection", () => {
    const carried = carryEffortToModel({
      row: ORG_LUNA,
      previousEffort: "high",
      purpose,
      selectionsSupported: true,
    });
    expect(carried.dropped).toBe("high");
    expect(carried.modelId).toBe("openai/gpt-5.6-luna");
    expect(carried.selection?.source).toBe("org");
    expect(carried.selection?.settings).toBeUndefined();
  });

  it("an effort change after reload keeps the org selection and connection", () => {
    const carried = carryEffortToModel({
      row: ORG_SONNET,
      previousEffort: undefined,
      purpose,
      selectionsSupported: true,
    });
    const input = reload({
      modelId: carried.modelId,
      selection: carried.selection,
    });
    const row = editorRow(input)!;
    const next = setEffortForRow({
      row,
      selection: input.modelSelection,
      effort: "high",
      purpose,
      bareIds: "canonicalize",
    })!;
    expect(next.modelId).toBe("anthropic/claude-sonnet-5");
    expect(next.selection).toMatchObject({
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_anthropic" },
    });
    expect(selectionReasoningEffort(next.selection)).toBe("high");
    expect(editorRow(reload(next))).toBe(ORG_SONNET);
  });

  it("keeps the chosen connection when the policy allows both hosted and org rows", () => {
    const carried = carryEffortToModel({
      row: ORG_LUNA,
      previousEffort: undefined,
      purpose,
      selectionsSupported: true,
    });
    expect(carried.modelId).toBe("openai/gpt-5.6-luna");
    expect(carried.selection).toMatchObject({
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_openai" },
    });
    const hosted = {
      ...ORG_LUNA,
      id: "openai/gpt-5.6-luna",
      hosted: true,
      orgProvider: undefined,
    };
    const otherConnection = {
      ...ORG_LUNA,
      orgProvider: { providerKey: "openai", id: "another-connection" },
    };
    expect(
      findModelForStoredChoice(
        { modelId: carried.modelId, selection: carried.selection },
        [hosted, otherConnection, ORG_LUNA],
        undefined,
        { exactSelection: false },
      ),
    ).toBe(ORG_LUNA);
  });
});

describe("orgCanonicalTarget", () => {
  it("is shared by the eval picker, which keeps its behavior", () => {
    expect(pickedModelTarget(ORG_LUNA, true)).toEqual(
      orgCanonicalTarget(ORG_LUNA, "evalTarget"),
    );
    expect(pickedModelTarget(ORG_LUNA, false)).toEqual({
      modelId: "gpt-5.6-luna",
    });
  });

  it("is undefined for a row whose selection sits beside its own id", () => {
    const hosted = {
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      provider: "openai",
      hosted: true,
    } as ModelDefinition;
    expect(orgCanonicalTarget(hosted, purpose)).toBeUndefined();
  });
});

describe("client editor rows under the organization key policy", () => {
  // An organization Bedrock row whose bare id has no canonical catalog id: a
  // pick could save only the bare id, which the policy refuses after reload.
  const ORG_BEDROCK_CUSTOM = {
    id: "acme.custom-model-v1:0",
    name: "Acme custom",
    provider: "bedrock",
    hosted: false,
    orgProvider: { providerKey: "bedrock", id: "orgprov_bedrock" },
  } as ModelDefinition;
  const HOSTED_DISALLOWED = {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    disabled: true,
    disabledReason: "org_keys",
  } as ModelDefinition;
  const rows = [ORG_LUNA, ORG_SONNET, ORG_BEDROCK_CUSTOM, HOSTED_DISALLOWED];

  it("offers only rows a pick saves with an org selection", () => {
    expect(orgKeysSavableRows(rows, true, purpose)).toEqual([
      ORG_LUNA,
      ORG_SONNET,
      HOSTED_DISALLOWED,
    ]);
  });

  it("leaves the list alone with the policy off", () => {
    expect(orgKeysSavableRows(rows, false, purpose)).toBe(rows);
  });
});
