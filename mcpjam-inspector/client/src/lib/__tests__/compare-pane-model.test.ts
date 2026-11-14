import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import { paneModelDriftReason } from "../compare-pane-model";
import { runtimeChosenModelRow } from "../runtime-chosen-model";

const hosted: ModelDefinition = {
  id: "openai/gpt-5.5",
  name: "GPT-5.5",
  provider: "openai",
  hosted: true,
};

describe("a Compare pane's send-time model check", () => {
  it("lets the pane send when its session resolves the row it shows", () => {
    expect(
      paneModelDriftReason({ label: "ChatGPT", shown: hosted, resolved: { ...hosted } }),
    ).toBeUndefined();
  });

  it("holds Send, naming the pane, when the connection changed under it", () => {
    const orgRow: ModelDefinition = {
      ...hosted,
      hosted: false,
      orgProvider: { id: "org-connection-1" } as ModelDefinition["orgProvider"],
    };
    expect(
      paneModelDriftReason({ label: "ChatGPT", shown: hosted, resolved: orgRow }),
    ).toBe("ChatGPT's model or connection changed. Send again to use the current one.");
  });

  it("holds Send when the session fell back to another model", () => {
    expect(
      paneModelDriftReason({
        label: "Codex",
        shown: hosted,
        resolved: { ...hosted, id: "openai/gpt-5-mini", name: "GPT-5 mini" },
      }),
    ).toMatch(/^Codex's model or connection changed/);
  });

  it("treats Cursor Auto as one row on both sides", () => {
    const shown = runtimeChosenModelRow("cursor/auto")!;
    const resolved = runtimeChosenModelRow("cursor/auto")!;
    expect(paneModelDriftReason({ label: "Cursor CLI", shown, resolved })).toBeUndefined();
  });
});

describe("the runtime-chosen model row", () => {
  it("names Cursor Auto and explains the account picks the model", () => {
    expect(runtimeChosenModelRow("cursor/auto")).toMatchObject({
      id: "cursor/auto",
      name: "Cursor Auto",
      disabled: true,
      disabledReason: "This host's runtime chooses its own model on your own account.",
    });
  });

  it("is absent for an ordinary model id", () => {
    expect(runtimeChosenModelRow("openai/gpt-5.5")).toBeUndefined();
  });
});
