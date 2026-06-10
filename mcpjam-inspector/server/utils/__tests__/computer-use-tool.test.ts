import { describe, it, expect, vi } from "vitest";
import { anthropic } from "@ai-sdk/anthropic";
import {
  COMPUTER_USE_TOOL_VERSIONS,
  resolveComputerUseToolVersion,
  buildComputerUseTools,
  mapToBrowserAction,
  summarizeWidgetToolCalls,
  toComputerModelOutput,
  type ComputerImplOutput,
} from "../computer-use-tool";
import type { McpAppBrowserHarness } from "../mcp-app-browser-harness";
import { logger } from "../logger";

describe("resolveComputerUseToolVersion", () => {
  it("resolves every mapped model id to its version", () => {
    for (const [model, version] of Object.entries(COMPUTER_USE_TOOL_VERSIONS)) {
      expect(resolveComputerUseToolVersion(model)).toBe(version);
    }
  });

  it("every mapped version exists as an AI SDK provider-tool factory (drift guard)", () => {
    const seen = new Set(Object.values(COMPUTER_USE_TOOL_VERSIONS));
    for (const version of seen) {
      expect(
        typeof (anthropic.tools as Record<string, unknown>)[
          `computer_${version}`
        ],
      ).toBe("function");
    }
  });

  it("matches dated / suffixed ids by longest prefix", () => {
    expect(resolveComputerUseToolVersion("claude-sonnet-4-5-20250929")).toBe(
      "20250124",
    );
    expect(resolveComputerUseToolVersion("claude-opus-4-8-20260115")).toBe(
      "20251124",
    );
    // longest-prefix: -4-8 wins over -4
    expect(resolveComputerUseToolVersion("claude-opus-4-8")).toBe("20251124");
    expect(resolveComputerUseToolVersion("claude-opus-4")).toBe("20250124");
  });

  it("strips provider prefixes", () => {
    expect(resolveComputerUseToolVersion("anthropic/claude-opus-4-8")).toBe(
      "20251124",
    );
    expect(resolveComputerUseToolVersion({ id: "anthropic.claude-sonnet-4" })).toBe(
      "20250124",
    );
  });

  it("normalizes dotted MCPJam version ids to hyphenated map keys", () => {
    // The default eval model id is dotted (`anthropic/claude-haiku-4.5`); the
    // map keys are hyphenated, so the dot must normalize or Computer Use is
    // silently dropped for the default model.
    expect(resolveComputerUseToolVersion("anthropic/claude-haiku-4.5")).toBe(
      "20250124",
    );
    expect(resolveComputerUseToolVersion("claude-sonnet-4.5")).toBe("20250124");
    expect(resolveComputerUseToolVersion("anthropic/claude-opus-4.6")).toBe(
      "20251124",
    );
    // dotted + dated suffix still resolves by longest prefix.
    expect(
      resolveComputerUseToolVersion("anthropic/claude-haiku-4.5-20251001"),
    ).toBe("20250124");
  });

  it("returns null for non-Claude / unmapped / empty models", () => {
    expect(resolveComputerUseToolVersion("gpt-4o")).toBeNull();
    expect(resolveComputerUseToolVersion("gemini-2.5-pro")).toBeNull();
    expect(resolveComputerUseToolVersion("claude-2.1")).toBeNull();
    expect(resolveComputerUseToolVersion(undefined)).toBeNull();
    expect(resolveComputerUseToolVersion(null)).toBeNull();
    expect(resolveComputerUseToolVersion("")).toBeNull();
  });
});

describe("mapToBrowserAction", () => {
  it("maps clicks and movement with coordinates", () => {
    expect(
      mapToBrowserAction({ action: "left_click", coordinate: [1, 2] }),
    ).toEqual({ action: "left_click", coordinate: [1, 2] });
    expect(mapToBrowserAction({ action: "triple_click", coordinate: [3, 4] })).toEqual(
      { action: "double_click", coordinate: [3, 4] },
    );
  });
  it("maps scroll with amount + direction", () => {
    expect(
      mapToBrowserAction({
        action: "scroll",
        coordinate: [5, 6],
        scroll_amount: 3,
        scroll_direction: "down",
      }),
    ).toEqual({
      action: "scroll",
      coordinate: [5, 6],
      scrollAmount: 3,
      scrollDirection: "down",
    });
  });
  it("maps type/key text", () => {
    expect(mapToBrowserAction({ action: "type", text: "hi" })).toEqual({
      action: "type",
      text: "hi",
    });
    expect(mapToBrowserAction({ action: "key", text: "Enter" })).toEqual({
      action: "key",
      text: "Enter",
    });
  });
  it("falls back to screenshot for unsupported actions", () => {
    expect(mapToBrowserAction({ action: "zoom" })).toEqual({
      action: "screenshot",
    });
    expect(mapToBrowserAction({ action: "left_click_drag" })).toEqual({
      action: "screenshot",
    });
  });
});

describe("summarizeWidgetToolCalls", () => {
  it("returns null for no calls", () => {
    expect(summarizeWidgetToolCalls([])).toBeNull();
  });
  it("formats ok and error calls", () => {
    const s = summarizeWidgetToolCalls([
      { name: "get_flights", args: { date: "2026-01-01" }, ok: true, elapsedMs: 1 },
      { name: "reserve", args: { seat: 12 }, ok: false, error: "sold out", elapsedMs: 2 },
    ]);
    expect(s).toContain("get_flights(date=2026-01-01) → OK");
    expect(s).toContain("reserve(seat=12) → ERROR(sold out)");
  });
});

describe("toComputerModelOutput", () => {
  const base: ComputerImplOutput = {
    widgetToolCalls: [],
    action: { action: "left_click" },
    elapsedMs: 1,
  };

  it("empty tool calls + screenshot => single image part", () => {
    const out = toComputerModelOutput({
      ...base,
      screenshotBase64: "iVBORw0KGgoSCREEN",
    });
    expect(out.type).toBe("content");
    expect(out.value).toHaveLength(1);
    expect(out.value[0]).toMatchObject({
      type: "image-data",
      mediaType: "image/png",
    });
  });

  it("detects jpeg media type from base64 header", () => {
    const out = toComputerModelOutput({ ...base, screenshotBase64: "/9j/4AAQ" });
    expect(out.value[0]).toMatchObject({ mediaType: "image/jpeg" });
  });

  it("one tool call => image + summary text", () => {
    const out = toComputerModelOutput({
      ...base,
      screenshotBase64: "iVBORshot",
      widgetToolCalls: [
        { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 3 },
      ],
    });
    expect(out.value.some((p) => p.type === "image-data")).toBe(true);
    expect(
      out.value.some((p) => p.type === "text" && p.text.includes("reserve(seat=12)")),
    ).toBe(true);
  });

  it("budget-exceeded note surfaces to the model", () => {
    const out = toComputerModelOutput({ ...base, note: "budget_exceeded" });
    expect(
      out.value.some(
        (p) => p.type === "text" && p.text.includes("budget_exceeded"),
      ),
    ).toBe(true);
  });

  it("no screenshot + no calls => a textual placeholder (never empty)", () => {
    const out = toComputerModelOutput(base);
    expect(out.value).toHaveLength(1);
    expect(out.value[0]).toMatchObject({ type: "text" });
  });
});

describe("buildComputerUseTools", () => {
  function stubHarness() {
    const executeAction = vi.fn(
      async ({ action }: { toolCallId: string; action: unknown }) => ({
        action,
        screenshotBase64: "iVBORscreenshot",
        widgetToolCalls: [
          { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 4 },
        ],
        elapsedMs: 7,
      }),
    );
    const dismissWidget = vi.fn(async () => {});
    return {
      harness: { executeAction, dismissWidget } as unknown as McpAppBrowserHarness,
      executeAction,
      dismissWidget,
    };
  }

  it("returns a provider-native computer tool and a regular finish_widget tool", () => {
    const { harness } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-1",
      viewport: { width: 1280, height: 800 },
    });
    expect(tools.computer).toBeDefined();
    expect(tools.finish_widget).toBeDefined();
    // finish_widget is a plain AI SDK tool with an input schema (no provider id).
    expect(
      (tools.finish_widget as { inputSchema?: unknown }).inputSchema,
    ).toBeDefined();
  });

  it("computer.execute drives the harness and toModelOutput renders the result", async () => {
    const { harness, executeAction } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20251124",
      harness,
      getActiveToolCallId: () => "tc-active",
      viewport: { width: 1024, height: 768 },
    });
    const exec = (tools.computer as { execute: Function }).execute;
    const impl = (await exec(
      { action: "left_click", coordinate: [512, 384] },
      {},
    )) as ComputerImplOutput;

    expect(executeAction).toHaveBeenCalledWith({
      toolCallId: "tc-active",
      action: { action: "left_click", coordinate: [512, 384] },
    });
    expect(impl.widgetToolCalls).toHaveLength(1);

    const toModelOutput = (tools.computer as { toModelOutput: Function })
      .toModelOutput;
    const mo = toModelOutput({ output: impl });
    expect(mo.type).toBe("content");
    expect(mo.value.some((p: { type: string }) => p.type === "image-data")).toBe(
      true,
    );
  });

  it("computer.execute returns 'no_rendered_widget' when none is active", async () => {
    const { harness, executeAction } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => null,
      viewport: { width: 1280, height: 800 },
    });
    const exec = (tools.computer as { execute: Function }).execute;
    const impl = (await exec({ action: "screenshot" }, {})) as ComputerImplOutput;
    expect(impl.note).toBe("no_rendered_widget");
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("onAction fires once per real action with the harness result + toolCallId", async () => {
    const { harness } = stubHarness();
    const onAction = vi.fn();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-active",
      viewport: { width: 1280, height: 800 },
      onAction,
    });
    const exec = (tools.computer as { execute: Function }).execute;
    await exec({ action: "left_click", coordinate: [10, 20] }, {});

    expect(onAction).toHaveBeenCalledTimes(1);
    const [result, context] = onAction.mock.calls[0]!;
    // The raw harness BrowserActionResult — not the model-facing impl output.
    expect(result).toMatchObject({
      screenshotBase64: "iVBORscreenshot",
      widgetToolCalls: [
        { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 4 },
      ],
      elapsedMs: 7,
    });
    expect(context).toEqual({ toolCallId: "tc-active" });
  });

  it("onAction does NOT fire on the no-widget short-circuit", async () => {
    const { harness, executeAction } = stubHarness();
    const onAction = vi.fn();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => null,
      viewport: { width: 1280, height: 800 },
      onAction,
    });
    const exec = (tools.computer as { execute: Function }).execute;
    const impl = (await exec({ action: "screenshot" }, {})) as ComputerImplOutput;

    expect(impl.note).toBe("no_rendered_widget");
    expect(executeAction).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("a throwing onAction is caught + logged; execute still returns the result", async () => {
    const { harness } = stubHarness();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const onAction = vi.fn(() => {
      throw new Error("emitter boom");
    });
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-active",
      viewport: { width: 1280, height: 800 },
      onAction,
    });
    const exec = (tools.computer as { execute: Function }).execute;
    const impl = (await exec(
      { action: "left_click", coordinate: [1, 2] },
      {},
    )) as ComputerImplOutput;

    // A buggy emitter must not crash the agent loop.
    expect(impl.widgetToolCalls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[computer-use] onAction callback threw",
      expect.objectContaining({ error: "emitter boom" }),
    );
    warnSpy.mockRestore();
  });

  it("finish_widget.execute dismisses the named widget", async () => {
    const { harness, dismissWidget } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-1",
      viewport: { width: 1280, height: 800 },
    });
    const exec = (tools.finish_widget as { execute: Function }).execute;
    const out = await exec({ toolCallId: "tc-1" }, {});
    expect(dismissWidget).toHaveBeenCalledWith("tc-1");
    expect(out).toMatchObject({ ok: true, dismissed: "tc-1" });
  });

  it("finish_widget.execute reports no dismissal when no widget is active", async () => {
    const { harness, dismissWidget } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => null,
      viewport: { width: 1280, height: 800 },
    });
    const exec = (tools.finish_widget as { execute: Function }).execute;
    const out = await exec({ toolCallId: "tc-stale" }, {});
    // No live widget -> don't claim success, and don't call dismiss.
    expect(dismissWidget).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, dismissed: null });
  });

  it("finish_widget.execute dismisses the live widget even when the model passes a stale id", async () => {
    const { harness, dismissWidget } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-live",
      viewport: { width: 1280, height: 800 },
    });
    const exec = (tools.finish_widget as { execute: Function }).execute;
    const out = await exec({ toolCallId: "tc-stale" }, {});
    // Dismisses the actually-mounted widget, not the (wrong) requested id...
    expect(dismissWidget).toHaveBeenCalledWith("tc-live");
    expect(dismissWidget).not.toHaveBeenCalledWith("tc-stale");
    // ...and reports the truth: what was dismissed vs. what was requested.
    expect(out).toMatchObject({
      ok: true,
      dismissed: "tc-live",
      requested: "tc-stale",
    });
  });
});

describe("buildComputerUseTools — wireFormat (hosted paths, PR 14)", () => {
  function stubHarness() {
    const executeAction = vi.fn(
      async ({ action }: { toolCallId: string; action: unknown }) => ({
        action,
        screenshotBase64: "iVBORscreenshot",
        widgetToolCalls: [],
        elapsedMs: 7,
      }),
    );
    const dismissWidget = vi.fn(async () => {});
    return {
      harness: {
        executeAction,
        dismissWidget,
      } as unknown as McpAppBrowserHarness,
      executeAction,
      dismissWidget,
    };
  }

  it("emits `computer` as a regular function tool with a JSON-serializable schema", async () => {
    const { harness } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-1",
      viewport: { width: 1280, height: 800 },
      wireFormat: true,
    });

    const computer = tools.computer as Record<string, unknown>;
    // Not the provider-defined factory output: a plain function tool whose
    // schema survives `serializeToolsForConvex` (the provider tool's lazy
    // schema serializes to an empty object on the hosted wire).
    expect(computer.type ?? "function").not.toBe("provider-defined");
    expect(typeof computer.description).toBe("string");
    const { serializeToolsForConvex } = await import("../mcpjam-tool-helpers");
    const defs = serializeToolsForConvex(tools as never);
    const computerDef = defs.find((d) => d.name === "computer");
    expect(computerDef).toBeDefined();
    const props = (computerDef!.inputSchema as { properties?: object })
      .properties;
    expect(Object.keys(props ?? {})).toEqual(
      expect.arrayContaining(["action", "coordinate", "text"]),
    );
    const actionEnum = (
      (props as Record<string, { enum?: string[] }>).action ?? {}
    ).enum;
    expect(actionEnum).toEqual(expect.arrayContaining(["screenshot", "left_click", "type", "key", "scroll", "wait"]));
  });

  it("wire `computer` drives the harness and maps output via toModelOutput like the native tool", async () => {
    const { harness, executeAction } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-9",
      viewport: { width: 1280, height: 800 },
      wireFormat: true,
    });

    const computer = tools.computer as {
      execute: Function;
      toModelOutput: Function;
    };
    const implOut = await computer.execute(
      { action: "left_click", coordinate: [10, 20] },
      {},
    );
    expect(executeAction).toHaveBeenCalledWith({
      toolCallId: "tc-9",
      action: { action: "left_click", coordinate: [10, 20] },
    });

    const modelOut = computer.toModelOutput({ output: implOut });
    expect(modelOut.type).toBe("content");
    expect(modelOut.value[0]).toMatchObject({
      type: "image-data",
      data: "iVBORscreenshot",
    });
  });

  it("wire mode still short-circuits with no_rendered_widget when nothing is mounted", async () => {
    const { harness, executeAction } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => null,
      viewport: { width: 1280, height: 800 },
      wireFormat: true,
    });

    const computer = tools.computer as { execute: Function };
    const out = await computer.execute({ action: "screenshot" }, {});
    expect(executeAction).not.toHaveBeenCalled();
    expect(out).toMatchObject({ note: "no_rendered_widget" });
  });

  it("wire mode fires onAction with the active toolCallId", async () => {
    const { harness } = stubHarness();
    const onAction = vi.fn();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => "tc-act",
      viewport: { width: 1280, height: 800 },
      wireFormat: true,
      onAction,
    });

    await (tools.computer as { execute: Function }).execute(
      { action: "screenshot" },
      {},
    );
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][1]).toEqual({ toolCallId: "tc-act" });
  });

  it("default (no wireFormat) keeps the provider-native factory", () => {
    const { harness } = stubHarness();
    const tools = buildComputerUseTools({
      version: "20250124",
      harness,
      getActiveToolCallId: () => null,
      viewport: { width: 1280, height: 800 },
    });
    // Provider-defined tools carry the factory id; the wire tool must not.
    expect((tools.computer as { id?: string }).id).toMatch(/anthropic\./);
  });
});
