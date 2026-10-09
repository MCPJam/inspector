import { describe, expect, it } from "vitest";
import {
  applyHarnessModelLocks,
  harnessDefaultModel,
  harnessModelLockReason,
  harnessModelRefusalReason,
  harnessPickerModels,
} from "../harness-model-locks";
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
      harnessModelRefusalReason(
        "openai/gpt-5.6-luna",
        { harnessId: "codex" },
        "eval",
      ),
    ).toMatch(/Codex harness can't run this host's model/);
    expect(
      harnessModelRefusalReason(
        "openai/gpt-5.5",
        { harnessId: "codex" },
        "eval",
      ),
    ).toBeUndefined();
  });

  it("an emulated or unknown client refuses nothing", () => {
    expect(
      harnessModelRefusalReason("openai/gpt-5.6-luna", null, "eval"),
    ).toBeUndefined();
    expect(
      harnessModelLockReason(
        "openai/gpt-5.6-luna",
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
      disabledReason: expect.stringContaining("Codex harness"),
    });
    expect(locked[2]!.disabledReason).toBe("Out of credits");
  });

  it("returns the input untouched with no harness client", () => {
    expect(applyHarnessModelLocks(MODELS, [null], "eval")).toBe(MODELS);
  });
});

// The picker for ONE harness client offers only what that harness runs.
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

describe("harnessPickerModels", () => {
  it("offers a Codex client only the MCPJam-provided models Codex can run", () => {
    expect(ids(harnessPickerModels(CATALOG, { harnessId: "codex" }))).toEqual([
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
    ]);
  });

  it("keeps a model Claude Code has not verified, with the reason as a warning", () => {
    const models = harnessPickerModels(CATALOG, { harnessId: "claude-code" });
    expect(ids(models)).toEqual(["anthropic/claude-haiku-4.5", "anthropic/claude-fable-5"]);
    expect(models[0]!.warningReason).toBeUndefined();
    expect(models[1]!.warningReason).toMatch(/not verified/);
  });

  it("leaves an emulated client's list alone", () => {
    expect(harnessPickerModels(CATALOG, null)).toBe(CATALOG);
  });

  it("leaves the list alone rather than emptying it when nothing is runnable", () => {
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
