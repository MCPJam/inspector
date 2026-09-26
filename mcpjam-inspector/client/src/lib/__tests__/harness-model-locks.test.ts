import { describe, expect, it } from "vitest";
import {
  applyHarnessModelLocks,
  harnessModelLockReason,
  harnessModelRefusalReason,
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
