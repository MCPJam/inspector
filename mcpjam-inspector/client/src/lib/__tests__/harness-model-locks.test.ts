import { describe, expect, it } from "vitest";
import {
  applyHarnessModelLocks,
  harnessChoiceRefusalReason,
  harnessDefaultModel,
  harnessModelLockReason,
  harnessModelLockReasonsByRow,
  harnessPickerModels,
  harnessRowRefusalReason,
  isNoRunnableHarnessModel,
  noRunnableHarnessModel,
} from "../harness-model-locks";
import {
  INSPECTOR_RUN_POLICY_REASON,
  ORG_KEYS_MODEL_REASON,
} from "@/lib/org-keys-refusal";
import { modelRowKey } from "@/components/chat-v2/shared/model-selection";
import type { ModelDefinition } from "@/shared/types";

const MODELS = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", provider: "openai" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku",
    provider: "anthropic",
    disabled: true,
    disabledReason: "Out of credits",
  },
] as ModelDefinition[];

describe("harness model locks", () => {
  it("refuses at the pinned version when none is given", () => {
    expect(
      harnessChoiceRefusalReason(
        { modelId: "openai/gpt-5.6-luna" },
        { harnessId: "codex" },
        "eval",
      ),
    ).toMatch(/not.*verified/);
    expect(
      harnessChoiceRefusalReason(
        { modelId: "openai/gpt-5.5" },
        { harnessId: "codex" },
        "eval",
      ),
    ).toBeUndefined();
  });

  it("an emulated or unknown client refuses nothing", () => {
    expect(
      harnessChoiceRefusalReason(
        { modelId: "openai/gpt-5.6-luna" },
        null,
        "eval",
      ),
    ).toBeUndefined();
    expect(
      harnessModelLockReason(
        MODELS[1]!,
        [{ harnessId: "codex" }, undefined],
        "eval",
      ),
    ).toBeUndefined();
  });

  it("locks only what every client refuses, keeping existing locks", () => {
    const locked = applyHarnessModelLocks(
      MODELS,
      [{ harnessId: "codex" }],
      "eval",
    );
    expect(locked[0]!.disabled).toBeFalsy();
    expect(locked[1]).toMatchObject({
      disabled: true,
      disabledReason: expect.stringMatching(/codex/i),
    });
    expect(locked[2]!.disabledReason).toBe("Out of credits");
  });

  it("returns the input untouched with no harness client", () => {
    expect(applyHarnessModelLocks(MODELS, [null], "eval")).toBe(MODELS);
  });
});

// The picker for ONE harness client offers only what that harness runs; the
// rest stay listed, disabled, with the reason.
const CATALOG = [
  { id: "anthropic/claude-haiku-4.5", name: "Haiku", provider: "anthropic", hosted: true },
  { id: "anthropic/claude-fable-5", name: "Fable 5", provider: "anthropic", hosted: true },
  { id: "openai/gpt-5-mini", name: "GPT-5 mini", provider: "openai", hosted: true },
  { id: "openai/gpt-5-nano", name: "GPT-5 nano", provider: "openai", hosted: true },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", hosted: true },
  // The same id through the user's own key: a harness turn refuses it.
  { id: "openai/gpt-5-nano", name: "GPT-5 nano (own key)", provider: "openai", hosted: false },
] as ModelDefinition[];
const ids = (models: ModelDefinition[]) => models.map((m) => `${m.id}${m.hosted ? "" : " (own)"}`);
const offered = (models: ModelDefinition[]) => models.filter((m) => !m.disabled);

describe("harnessPickerModels", () => {
  it("offers a Codex client only the MCPJam-provided models Codex can run", () => {
    const rows = harnessPickerModels(CATALOG, { harnessId: "codex" });
    expect(ids(offered(rows))).toEqual([
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
      "openai/gpt-5.6-luna",
    ]);
  });

  it("shows the rows Codex can't run disabled, each with the server's reason", () => {
    const rows = harnessPickerModels(CATALOG, { harnessId: "codex" });
    expect(rows).toHaveLength(CATALOG.length);
    expect(rows[0]).toMatchObject({
      id: "anthropic/claude-haiku-4.5",
      disabled: true,
      disabledReason: "This model isn’t supported by Codex. Choose a supported model or switch clients.",
    });
    expect(rows.at(-1)).toMatchObject({
      disabled: true,
      disabledReason: "The Codex client needs an MCPJam model or your organization's OpenAI key. Choose a supported model.",
    });
  });

  it("keeps a model Claude Code has not verified, with the reason as a warning", () => {
    const models = offered(harnessPickerModels(CATALOG, { harnessId: "claude-code" }));
    expect(ids(models)).toEqual(["anthropic/claude-haiku-4.5", "anthropic/claude-fable-5"]);
    expect(models[0]!.warningReason).toBeUndefined();
    expect(models[1]!.warningReason).toMatch(/not been verified/);
  });

  it("leaves an emulated client's list alone", () => {
    expect(harnessPickerModels(CATALOG, null)).toBe(CATALOG);
  });

  it("leaves an external-account catalog alone when nothing in it is runnable", () => {
    // Cursor runs on the user's Cursor account, which picks its own model.
    expect(harnessPickerModels(CATALOG, { harnessId: "cursor" })).toBe(CATALOG);
  });
});

describe("harnessDefaultModel", () => {
  const codex = harnessPickerModels(CATALOG, { harnessId: "codex" });

  it("starts on the client's own model", () => {
    expect(harnessDefaultModel(codex, { harnessId: "codex" }, "openai/gpt-5-nano")?.id).toBe(
      "openai/gpt-5-nano",
    );
  });

  it("falls back to the first supported model, never the emulated Claude default", () => {
    expect(harnessDefaultModel(codex, { harnessId: "codex" }, "anthropic/claude-haiku-4.5")?.id).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("skips a disabled row, the client's own included", () => {
    const locked = codex.map((m) =>
      m.id === "openai/gpt-5-nano" ? { ...m, disabled: true } : m,
    );
    expect(harnessDefaultModel(locked, { harnessId: "codex" }, "openai/gpt-5-nano")?.id).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("prefers a supported model over an unverified one", () => {
    const claude = harnessPickerModels(
      [CATALOG[1]!, CATALOG[0]!],
      { harnessId: "claude-code" },
    );
    expect(harnessDefaultModel(claude, { harnessId: "claude-code" })?.id).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });
});

// Rows from organization provider connections: the org's own key.
const ORG_ANTHROPIC = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5 (org)",
  provider: "anthropic",
  hosted: false,
  orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
} as ModelDefinition;
const ORG_OPENAI = {
  id: "gpt-5-mini",
  name: "GPT-5 mini (org)",
  provider: "openai",
  hosted: false,
  orgProvider: { providerKey: "openai", id: "orgprov_openai" },
} as ModelDefinition;
const ORG_OPENROUTER_CLAUDE = {
  id: "anthropic/claude-haiku-4.5",
  name: "Haiku via OpenRouter",
  provider: "openrouter",
  hosted: false,
  orgProvider: { providerKey: "openrouter", id: "orgprov_openrouter" },
} as ModelDefinition;
const LOCAL_ANTHROPIC = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5 (own key)",
  provider: "anthropic",
  hosted: false,
} as ModelDefinition;
// An org row neither the reviewed exceptions nor the catalog list: its
// canonical id comes from the vendor prefix (`anthropic/claude-experimental-x`).
const ORG_ANTHROPIC_UNKNOWN = {
  id: "claude-experimental-x",
  name: "Experimental",
  provider: "anthropic",
  hosted: false,
  orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
} as ModelDefinition;

describe("organization-key rows on a harness", () => {
  const WITH_ORG = [
    ...CATALOG,
    ORG_ANTHROPIC,
    ORG_OPENAI,
    ORG_OPENROUTER_CLAUDE,
    LOCAL_ANTHROPIC,
    ORG_ANTHROPIC_UNKNOWN,
  ];

  it("Claude Code offers hosted rows plus the org's Anthropic rows", () => {
    expect(
      offered(harnessPickerModels(WITH_ORG, { harnessId: "claude-code" })).map(
        modelRowKey,
      ),
    ).toEqual([
      "hosted:anthropic:anthropic/claude-haiku-4.5",
      "hosted:anthropic:anthropic/claude-fable-5",
      "org:orgprov_anthropic:claude-sonnet-4-5",
      "org:orgprov_anthropic:claude-experimental-x",
    ]);
  });

  it("Codex offers hosted rows plus the org's OpenAI rows", () => {
    expect(
      offered(harnessPickerModels(WITH_ORG, { harnessId: "codex" })).map(modelRowKey),
    ).toEqual([
      "hosted:openai:openai/gpt-5-mini",
      "hosted:openai:openai/gpt-5-nano",
      "hosted:openai:openai/gpt-5.6-luna",
      "org:orgprov_openai:gpt-5-mini",
    ]);
  });

  it("OpenCode offers hosted Anthropic rows plus the org's Anthropic rows", () => {
    expect(
      offered(harnessPickerModels(WITH_ORG, { harnessId: "opencode" })).map(modelRowKey),
    ).toEqual([
      "hosted:anthropic:anthropic/claude-haiku-4.5",
      "hosted:anthropic:anthropic/claude-fable-5",
      "org:orgprov_anthropic:claude-sonnet-4-5",
      "org:orgprov_anthropic:claude-experimental-x",
    ]);
    expect(
      harnessRowRefusalReason(
        ORG_OPENAI,
        { harnessId: "opencode" },
        "chat",
      ),
    ).toBe(
      "The OpenCode client needs an MCPJam model or your organization's Anthropic key. Choose a supported model.",
    );
  });

  it("refuses another vendor's org connection and a local key", () => {
    for (const row of [ORG_OPENROUTER_CLAUDE, LOCAL_ANTHROPIC, ORG_OPENAI]) {
      expect(
        harnessRowRefusalReason(row, { harnessId: "claude-code" }, "chat"),
      ).toMatch(/MCPJam model or your organization's Anthropic key/);
    }
    expect(
      harnessRowRefusalReason(
        ORG_ANTHROPIC,
        { harnessId: "claude-code" },
        "eval",
      ),
    ).toBeUndefined();
  });

  it("reads the evidence on the CANONICAL id of an org row", () => {
    // The native `claude-sonnet-4-5` is canonical `anthropic/claude-sonnet-4.5`,
    // which the table supports — so it is not even warned about.
    const [row] = harnessPickerModels([ORG_ANTHROPIC], {
      harnessId: "claude-code",
    });
    expect(row).toBe(ORG_ANTHROPIC);
  });

  it("an empty state, never the unfiltered list, when nothing is runnable", () => {
    const rows = harnessPickerModels([LOCAL_ANTHROPIC, ORG_OPENROUTER_CLAUDE], {
      harnessId: "claude-code",
    });
    expect(offered(rows)).toEqual([]);
    expect(rows.map((row) => row.disabledReason)).toEqual([
      expect.stringMatching(/organization's Anthropic key/),
      expect.stringMatching(/organization's Anthropic key/),
    ]);
  });

  it("an org-only catalog leaves OpenCode empty rather than restoring refused rows", () => {
    expect(
      harnessPickerModels([ORG_OPENAI], { harnessId: "opencode" }),
    ).toEqual([
      {
        ...ORG_OPENAI,
        disabled: true,
        disabledReason:
          "The OpenCode client needs an MCPJam model or your organization's Anthropic key. Choose a supported model.",
      },
    ]);
  });

  it("locks per ROW: the hosted row and an org row of one id can differ", () => {
    const sameId = [
      {
        id: "anthropic/claude-haiku-4.5",
        name: "Haiku",
        provider: "anthropic",
        hosted: true,
      },
      ORG_OPENROUTER_CLAUDE,
    ] as ModelDefinition[];
    const reasons = harnessModelLockReasonsByRow(
      sameId,
      [{ harnessId: "claude-code" }],
      "eval",
    );
    expect(reasons.has(modelRowKey(sameId[0]!))).toBe(false);
    expect(reasons.get(modelRowKey(ORG_OPENROUTER_CLAUDE))).toMatch(
      /organization's Anthropic key/,
    );
    const locked = applyHarnessModelLocks(
      sameId,
      [{ harnessId: "claude-code" }],
      "eval",
    );
    expect(locked[0]!.disabled).toBeFalsy();
    expect(locked[1]!.disabled).toBe(true);
  });

  it("a row one of several clients can run stays unlocked", () => {
    expect(
      harnessModelLockReason(
        ORG_OPENAI,
        [{ harnessId: "claude-code" }, { harnessId: "codex" }],
        "eval",
      ),
    ).toBeUndefined();
  });

  it("an external-account harness reads the evidence table alone, as before", () => {
    expect(
      harnessRowRefusalReason(ORG_ANTHROPIC, { harnessId: "cursor" }, "chat"),
    ).toMatch(/Cursor/);
  });
});

describe("a harness under the organization's key policy", () => {
  const POLICY = { requireOrgKeys: true };
  const WITH_ORG = [
    ...CATALOG,
    ORG_ANTHROPIC,
    ORG_OPENAI,
    ORG_OPENROUTER_CLAUDE,
    LOCAL_ANTHROPIC,
  ];

  it("Claude Code offers only the organization's Anthropic rows", () => {
    expect(
      offered(harnessPickerModels(WITH_ORG, { harnessId: "claude-code" }, POLICY)).map(
        modelRowKey,
      ),
    ).toEqual(["org:orgprov_anthropic:claude-sonnet-4-5"]);
  });

  it("Codex offers only the organization's OpenAI rows", () => {
    expect(
      offered(harnessPickerModels(WITH_ORG, { harnessId: "codex" }, POLICY)).map(
        modelRowKey,
      ),
    ).toEqual(["org:orgprov_openai:gpt-5-mini"]);
  });

  it("refuses an MCPJam-provided row with copy that offers no MCPJam model", () => {
    const hosted = CATALOG[0]!;
    expect(
      harnessRowRefusalReason(
        hosted,
        { harnessId: "claude-code" },
        "eval",
        POLICY,
      ),
    ).toBe(
      "The Claude Code client requires your organization's Anthropic key. Choose an organization model or contact your organization admin.",
    );
    const locked = applyHarnessModelLocks(
      [hosted, ORG_ANTHROPIC],
      [{ harnessId: "claude-code" }],
      "eval",
      POLICY,
    );
    expect(locked[0]).toMatchObject({ disabled: true });
    expect(locked[1]!.disabled).toBeFalsy();
    expect(
      harnessModelLockReasonsByRow(
        [ORG_OPENAI],
        [{ harnessId: "claude-code" }],
        "eval",
        POLICY,
      ).get(modelRowKey(ORG_OPENAI)),
    ).toMatch(/requires your organization's Anthropic key/);
  });

  it("keeps a saved model the policy no longer allows, so the trigger can warn", () => {
    const disallowed = {
      ...CATALOG[0]!,
      disabled: true,
      disabledReason: ORG_KEYS_MODEL_REASON,
    } as ModelDefinition;
    const [kept, org, other] = harnessPickerModels(
      [disallowed, ORG_ANTHROPIC, ORG_OPENAI],
      { harnessId: "claude-code" },
      POLICY,
    );
    expect(kept).toBe(disallowed);
    expect(org).toBe(ORG_ANTHROPIC);
    expect(other).toMatchObject({
      disabled: true,
      disabledReason: expect.stringMatching(/requires your organization's Anthropic key/),
    });
  });

  it("keeps the policy's reason on an Inspector-run connection the harness could run", () => {
    const inspectorRun = {
      ...ORG_ANTHROPIC,
      disabled: true,
      disabledReason: INSPECTOR_RUN_POLICY_REASON,
    } as ModelDefinition;
    const [kept] = harnessPickerModels(
      [inspectorRun],
      { harnessId: "claude-code" },
      POLICY,
    );
    expect(kept).toBe(inspectorRun);
  });

  it("gives the harness's refusal to an Inspector-run connection it can't use", () => {
    const inspectorRun = {
      id: "custom:lan:lan-model",
      name: "LAN / lan-model",
      provider: "custom",
      customProviderName: "lan",
      orgProvider: { providerKey: "custom:lan", id: "orgprov_lan" },
      hosted: false,
      disabled: true,
      disabledReason: INSPECTOR_RUN_POLICY_REASON,
    } as ModelDefinition;
    const [refused] = harnessPickerModels(
      [inspectorRun, ORG_ANTHROPIC],
      { harnessId: "claude-code" },
      POLICY,
    );
    expect(refused).toMatchObject({
      disabled: true,
      disabledReason: expect.stringMatching(
        /requires your organization's Anthropic key/,
      ),
    });
  });

  it("an empty list says which organization provider the harness needs", () => {
    expect(
      offered(
        harnessPickerModels(
          [ORG_OPENAI, ...CATALOG],
          { harnessId: "claude-code" },
          POLICY,
        ),
      ),
    ).toEqual([]);
    const standIn = noRunnableHarnessModel("claude-code", POLICY);
    expect(isNoRunnableHarnessModel(standIn)).toBe(true);
    expect(standIn.disabledReason).toBe(
      "This organization requires its own provider keys, so Claude Code runs only on an organization Anthropic provider or a gateway that serves Anthropic Messages.",
    );
  });
});

describe("harnessChoiceRefusalReason (a saved choice, no row)", () => {
  const org = (modelId: string) => ({
    modelId,
    selection: { source: "org" as const },
  });

  it("an org selection runs only on the harness's own vendor", () => {
    expect(
      harnessChoiceRefusalReason(
        org("anthropic/claude-sonnet-4.5"),
        { harnessId: "claude-code" },
        "eval",
      ),
    ).toBeUndefined();
    expect(
      harnessChoiceRefusalReason(
        org("openai/gpt-5-mini"),
        { harnessId: "claude-code" },
        "eval",
      ),
    ).toMatch(/organization's Anthropic key/);
    expect(
      harnessChoiceRefusalReason(
        org("anthropic/claude-haiku-4.5"),
        { harnessId: "opencode" },
        "eval",
      ),
    ).toBeUndefined();
    expect(
      harnessChoiceRefusalReason(
        org("anthropic/claude-haiku-4.5"),
        { harnessId: "cursor" },
        "eval",
      ),
    ).toMatch(/does not support organization provider keys/);
  });

  it("a local selection never runs on a brokered harness", () => {
    expect(
      harnessChoiceRefusalReason(
        {
          modelId: "anthropic/claude-sonnet-4.5",
          selection: { source: "local" },
        },
        { harnessId: "claude-code" },
        "eval",
      ),
    ).toMatch(/MCPJam model/);
    expect(
      harnessChoiceRefusalReason(
        {
          modelId: "anthropic/claude-haiku-4.5",
          selection: { source: "local" },
        },
        { harnessId: "opencode" },
        "chat",
      ),
    ).toBe(
      "The OpenCode client needs an MCPJam model or your organization's Anthropic key. Choose a supported model.",
    );
  });

  it("a hosted or legacy choice keeps the evidence rule", () => {
    expect(
      harnessChoiceRefusalReason(
        { modelId: "openai/gpt-5.6-luna" },
        { harnessId: "codex" },
        "eval",
      ),
    ).toMatch(/not.*verified/);
    expect(
      harnessChoiceRefusalReason(
        { modelId: "openai/gpt-5.6-luna" },
        null,
        "eval",
      ),
    ).toBeUndefined();
  });
});


it("keeps the measured old-runtime refusal while warning on the newer unverified model", () => {
  expect(harnessChoiceRefusalReason({ modelId: "openai/gpt-5.6-luna" },
    { harnessId: "codex", runtimeVersion: "0.149.1" }, "eval")).toMatch(/not.*supported|isn’t supported|can't run/);
  const rows = harnessPickerModels(CATALOG, { harnessId: "codex" });
  expect(rows.find((row) => row.id === "openai/gpt-5.6-luna")?.warningReason).toMatch(/not.*verified/);
});
