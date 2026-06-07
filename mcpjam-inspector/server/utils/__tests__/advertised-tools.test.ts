import { describe, it, expect, vi } from "vitest";
import {
  applyPrepareAdvertisedTools,
  type PrepareAdvertisedTools,
} from "../advertised-tools";

const DEFAULTS = ["search", "reserve", "computer", "finish_widget"];

describe("applyPrepareAdvertisedTools — contract", () => {
  it("returns the default set unchanged when no hook is provided", () => {
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 0,
    });
    expect(out).toBe(DEFAULTS); // same reference: no narrowing
  });

  it("returns the default set when the hook returns undefined", () => {
    const hook: PrepareAdvertisedTools = () => undefined;
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 3,
      prepareAdvertisedTools: hook,
    });
    expect(out).toBe(DEFAULTS);
  });

  it("narrows to the returned name list, preserving default order", () => {
    const hook: PrepareAdvertisedTools = () => ["reserve", "search"];
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 1,
      prepareAdvertisedTools: hook,
    });
    // intersection follows defaultToolNames order, not the hook's order
    expect(out).toEqual(["search", "reserve"]);
  });

  it("drops names that are not in the default set (defense-in-depth)", () => {
    const hook: PrepareAdvertisedTools = () => [
      "search",
      "not_a_real_tool",
      "computer",
    ];
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 0,
      prepareAdvertisedTools: hook,
    });
    expect(out).toEqual(["search", "computer"]);
  });

  it("supports narrowing to the empty set", () => {
    const hook: PrepareAdvertisedTools = () => [];
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 0,
      prepareAdvertisedTools: hook,
    });
    expect(out).toEqual([]);
  });

  it("logs via onWarn and falls back to the default set when the hook throws", () => {
    const onWarn = vi.fn();
    const hook: PrepareAdvertisedTools = () => {
      throw new Error("buggy hook");
    };
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 2,
      prepareAdvertisedTools: hook,
      onWarn,
    });
    expect(out).toBe(DEFAULTS);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][1]).toEqual({ error: "buggy hook" });
  });

  it("does not throw when the hook throws and no onWarn is provided", () => {
    const hook: PrepareAdvertisedTools = () => {
      throw new Error("boom");
    };
    expect(() =>
      applyPrepareAdvertisedTools({
        defaultToolNames: DEFAULTS,
        stepIndex: 0,
        prepareAdvertisedTools: hook,
      }),
    ).not.toThrow();
  });

  it("invokes the hook with { stepIndex, defaultToolNames }", () => {
    const hook = vi.fn().mockReturnValue(undefined);
    applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 5,
      prepareAdvertisedTools: hook,
    });
    expect(hook).toHaveBeenCalledWith({
      stepIndex: 5,
      defaultToolNames: DEFAULTS,
    });
  });
});

describe("applyPrepareAdvertisedTools — rendered-widget gate (eval use case)", () => {
  // Mirrors how the eval runner closes over harness state to hide the
  // Computer Use tools until an MCP App widget has actually rendered.
  const gate =
    (hasRenderedWidget: () => boolean): PrepareAdvertisedTools =>
    ({ defaultToolNames }) =>
      hasRenderedWidget()
        ? defaultToolNames
        : defaultToolNames.filter(
            (n) => n !== "computer" && n !== "finish_widget",
          );

  it("hides computer + finish_widget before any widget renders", () => {
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 0,
      prepareAdvertisedTools: gate(() => false),
    });
    expect(out).toEqual(["search", "reserve"]);
  });

  it("advertises computer + finish_widget once a widget is rendered", () => {
    const out = applyPrepareAdvertisedTools({
      defaultToolNames: DEFAULTS,
      stepIndex: 4,
      prepareAdvertisedTools: gate(() => true),
    });
    expect(out).toEqual(DEFAULTS);
  });
});
