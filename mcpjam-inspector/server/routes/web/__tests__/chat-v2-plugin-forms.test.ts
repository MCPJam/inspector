import { describe, expect, it } from "vitest";
import { chatPluginFormPlan } from "../chat-v2-plugin-forms.js";

const plan = (
  input: Partial<Parameters<typeof chatPluginFormPlan>[0]> & {
    pins?: Record<string, string | undefined>;
  },
) =>
  chatPluginFormPlan({
    harness: undefined,
    serverIds: ["a", "b"],
    pinFor: (id) => input.pins?.[id],
    mrtrEnabled: true,
    forms: true,
    ...input,
  });

describe("which OpenAI plugin form path a chat turn installs", () => {
  it("answers forms for a native Codex turn on an unpinned client", () => {
    // The Codex template pins no protocol: the Codex binary's turn calls its
    // MCP tools here, so the legacy handler must be installed and claimed.
    expect(plan({ harness: "codex" })).toEqual({
      admitted: true,
      modernServerIds: [],
      legacyServerIds: ["a", "b"],
    });
  });

  it("answers forms on an unpinned or 2025-11-25 emulated client", () => {
    expect(plan({}).legacyServerIds).toEqual(["a", "b"]);
    expect(
      plan({ pins: { a: "2025-11-25", b: "2025-11-25" } }).legacyServerIds,
    ).toEqual(["a", "b"]);
  });

  it("claims nothing with the client's Forms extension off", () => {
    expect(plan({ harness: "codex", forms: false })).toEqual({
      admitted: true,
      modernServerIds: [],
      legacyServerIds: [],
    });
    expect(plan({ forms: false }).legacyServerIds).toEqual([]);
  });

  it("never installs the MRTR adapter on a harness turn", () => {
    const pins = { a: "2026-07-28", b: "2026-07-28" };
    expect(plan({ pins }).modernServerIds).toEqual(["a", "b"]);
    expect(plan({ pins, harness: "codex" }).modernServerIds).toEqual([]);
  });

  it("keeps a mixed batch and older pins off the legacy handler", () => {
    expect(
      plan({ pins: { a: "2026-07-28", b: undefined } }).legacyServerIds,
    ).toEqual([]);
    expect(
      plan({ pins: { a: "2025-06-18", b: "2025-11-25" } }).legacyServerIds,
    ).toEqual([]);
  });

  it("admits no harness whose runtime calls MCP itself", () => {
    expect(plan({ harness: "claude-code" })).toEqual({
      admitted: false,
      modernServerIds: [],
      legacyServerIds: [],
    });
  });
});
