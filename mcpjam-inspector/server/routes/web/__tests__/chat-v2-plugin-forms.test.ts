import { describe, expect, it, vi } from "vitest";
import {
  chatPluginFormPlan,
  chatPluginToolExecutor,
} from "../chat-v2-plugin-forms.js";

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

  it("installs no MRTR adapter with Forms off, so ordinary calls still run", async () => {
    const pins = { a: "2026-07-28", b: "2026-07-28" };
    const turn = plan({ pins, forms: false });
    expect(turn.modernServerIds).toEqual([]);
    // The form-only adapter refuses any call it owns while Forms is off.
    const refusing = vi.fn(async () => {
      throw new Error("CONTINUATION_PROTOCOL_DENIED");
    });
    const executor = chatPluginToolExecutor({
      ...(turn.modernServerIds.length
        ? { modern: { serverIds: turn.modernServerIds, execute: refusing } }
        : {}),
      pinFor: (id) => pins[id as keyof typeof pins],
      negotiatedVersion: () => "2026-07-28",
    });
    const run = vi.fn(async () => "tool result");
    const execution = {
      serverKey: "a",
      toolName: "t",
      toolCallId: "c",
      input: {},
    };
    await expect(executor ? executor(execution, run) : run()).resolves.toBe(
      "tool result",
    );
    expect(refusing).not.toHaveBeenCalled();
  });

  it("lets an unpinned (Auto) emulated server take either form path", () => {
    expect(plan({})).toEqual({
      admitted: true,
      modernServerIds: ["a", "b"],
      legacyServerIds: ["a", "b"],
    });
    expect(plan({ mrtrEnabled: false }).modernServerIds).toEqual([]);
    expect(
      plan({ pins: { a: "2025-11-25", b: undefined } }).modernServerIds,
    ).toEqual(["b"]);
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

describe("which plugin executor a model tool call takes", () => {
  const execution = (serverKey: string) => ({
    serverKey,
    toolName: "t",
    toolCallId: "c",
    input: {},
  });
  const setup = (negotiated: Record<string, string | undefined>) => {
    const modern = vi.fn(async () => "modern");
    const legacy = vi.fn(async () => "legacy");
    const executor = chatPluginToolExecutor({
      modern: { serverIds: ["auto", "pinned"], execute: modern },
      legacy,
      pinFor: (id) => (id === "pinned" ? "2026-07-28" : undefined),
      negotiatedVersion: (id) => negotiated[id],
    })!;
    return { executor, modern, legacy };
  };
  const run = async () => "plain";

  it("sends an Auto server that negotiated 2026-07-28 to the MRTR adapter", async () => {
    const { executor, modern, legacy } = setup({ auto: "2026-07-28" });
    await expect(executor(execution("auto"), run)).resolves.toBe("modern");
    expect(modern).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("keeps an Auto server that negotiated a 2025 era on the legacy executor", async () => {
    const { executor, modern, legacy } = setup({ auto: "2025-11-25" });
    await expect(executor(execution("auto"), run)).resolves.toBe("legacy");
    expect(legacy).toHaveBeenCalledOnce();
    expect(modern).not.toHaveBeenCalled();
  });

  it("follows a 2026-07-28 pin, and runs as is with no legacy executor", async () => {
    const { executor } = setup({});
    await expect(executor(execution("pinned"), run)).resolves.toBe("modern");
    const modernOnly = chatPluginToolExecutor({
      modern: { serverIds: ["auto"], execute: async () => "modern" },
      pinFor: () => undefined,
      negotiatedVersion: () => "2025-11-25",
    })!;
    await expect(modernOnly(execution("auto"), run)).resolves.toBe("plain");
    const legacy = async () => "legacy";
    expect(
      chatPluginToolExecutor({
        legacy,
        pinFor: () => undefined,
        negotiatedVersion: () => undefined,
      }),
    ).toBe(legacy);
  });
});
