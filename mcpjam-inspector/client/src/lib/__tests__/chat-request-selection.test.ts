import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import { chatRequestSelection } from "../chat-request-selection";
import { resolveCompareCards } from "../compare-cards";

const model: ModelDefinition = {
  id: "gpt-4o", name: "GPT-4o", provider: "openai", hosted: false,
  orgProvider: { id: "connection-a", providerKey: "openai" },
};
const selection: ModelSelection = {
  modelId: "openai/gpt-4o", nativeModelId: "gpt-4o", source: "org",
  connectionRef: { kind: "orgProvider", id: "connection-a" },
  fallback: { provider: "none", model: "none" },
  settings: { reasoningEffort: "high" },
};
const args = { model, selection, intent: "picked" as const, allowLocal: false };

describe("chat request selection", () => {
  it("preserves the saved connection, native id and fallback", () => {
    expect(chatRequestSelection(args)).toEqual({ kind: "picked", selection });
  });
  it("derives an org choice only when no saved object exists", () => {
    expect(chatRequestSelection({ ...args, selection: undefined })).toMatchObject({
      kind: "picked", selection: { source: "org", connectionRef: selection.connectionRef },
    });
  });
  it("omits visitor choices and settings on inherited turns", () => {
    expect(chatRequestSelection({ ...args, intent: "inherit", effort: "low" }))
      .toEqual({ kind: "inherit" });
  });
  it("applies effort edits and explicit clearing without replacing other fields", () => {
    expect(chatRequestSelection({ ...args, effort: "low" })).toMatchObject({
      kind: "picked", selection: { ...selection, settings: { reasoningEffort: "low" } },
    });
    const { settings: _, ...cleared } = selection;
    expect(chatRequestSelection({ ...args, effort: null }))
      .toEqual({ kind: "picked", selection: cleared });
  });
  it.each(["removed-connection", "another-org-connection"])("blocks %s instead of rebinding", (id) => {
    const stale = { ...selection, connectionRef: { kind: "orgProvider" as const, id } };
    expect(chatRequestSelection({ ...args, selection: stale }).kind).toBe("blocked");
    expect(resolveCompareCards([stale], [model], undefined)).toEqual([]);
  });
  it("blocks a different canonical model", () => {
    expect(chatRequestSelection({ ...args, selection: { ...selection, modelId: "openai/gpt-5" } }).kind)
      .toBe("blocked");
  });
  it("validates saved objects rather than dropping unknown fields", () => {
    expect(chatRequestSelection({ ...args, selection: { ...selection, secret: "forbidden" } as ModelSelection }).kind)
      .toBe("blocked");
  });
  it("keeps already-saved hosted choices, including no-fallback", () => {
    const hosted: ModelSelection = { modelId: "openai/gpt-4o", source: "hosted", fallback: selection.fallback };
    expect(chatRequestSelection({ ...args, model: { ...model, id: hosted.modelId, hosted: true }, selection: hosted }))
      .toEqual({ kind: "picked", selection: hosted });
  });
  it("uses the chat fallback default for a new hosted choice", () => {
    expect(chatRequestSelection({ ...args, model: { ...model, id: "openai/gpt-4o", hosted: true }, selection: null }))
      .toMatchObject({ kind: "picked", selection: { source: "hosted", modelId: "openai/gpt-4o", fallback: { provider: "openrouter" } } });
  });
  it("supports local choices only on the MCP route", () => {
    const local: ModelSelection = {
      ...selection, source: "local", connectionRef: { kind: "localProvider", providerKey: "openai" },
    };
    const localArgs = { ...args, model: { ...model, orgProvider: undefined }, selection: local };
    expect(chatRequestSelection(localArgs).kind).toBe("blocked");
    expect(chatRequestSelection({ ...localArgs, allowLocal: true })).toEqual({ kind: "picked", selection: local });
  });
  it("rejects a native deployment mismatch", () => {
    expect(chatRequestSelection({ ...args, model: { ...model, nativeModelId: "other-deployment" } }).kind)
      .toBe("blocked");
  });
  it("rejects a native mismatch even when the row has no explicit native id", () => {
    expect(chatRequestSelection({ ...args,
      selection: { ...selection, nativeModelId: "other-deployment" },
    }).kind).toBe("blocked");
  });

  it("refuses unsupported efforts without silently stripping the saved choice", () => {
    expect(chatRequestSelection({ ...args, effortLevels: [] }).kind).toBe("blocked");
    expect(chatRequestSelection({ ...args, effortLevels: ["high"] }))
      .toEqual({ kind: "picked", selection });
    expect(chatRequestSelection({ ...args, effortLevels: [], effort: null }).kind).toBe("picked");
  });
  it("writes an explicit temperature edit into the preserved full selection", () => {
    expect(chatRequestSelection({ ...args, effort: null, temperature: 0.9 }))
      .toMatchObject({ kind: "picked", selection: { ...selection, settings: { temperature: 0.9 } } });
  });

  it("never substitutes another provider for an explicit legacy provider", () => {
    expect(chatRequestSelection({ ...args, allowLocal: true, model: { ...model, orgProvider: undefined },
      selection: { source: "legacy", modelId: String(model.id), provider: "anthropic" } }).kind).toBe("blocked");
  });
});
