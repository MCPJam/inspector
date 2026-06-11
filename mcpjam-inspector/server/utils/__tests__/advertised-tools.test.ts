import { describe, it, expect, vi } from "vitest";
import {
  applyPrepareAdvertisedTools,
  gateToolsToAdvertisedSubset,
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

describe("gateToolsToAdvertisedSubset — advertise = ENFORCE", () => {
  const makeTools = () => {
    const searchExec = vi.fn(async () => "search-result");
    const computerExec = vi.fn(async () => "computer-result");
    return {
      tools: {
        search: { description: "s", execute: searchExec },
        computer: { description: "c", execute: computerExec },
      },
      searchExec,
      computerExec,
    };
  };

  it("executes a tool that is in the advertised set", async () => {
    const { tools, searchExec } = makeTools();
    const gated = gateToolsToAdvertisedSubset(
      tools,
      () => new Set(["search"]),
    );
    await expect(
      (gated.search.execute as Function)({}, {}),
    ).resolves.toBe("search-result");
    expect(searchExec).toHaveBeenCalledTimes(1);
  });

  it("throws a recoverable error for a hidden tool (and does not run it)", async () => {
    const { tools, computerExec } = makeTools();
    const gated = gateToolsToAdvertisedSubset(
      tools,
      () => new Set(["search"]),
    );
    await expect(
      (gated.computer.execute as Function)({}, {}),
    ).rejects.toThrow(/not available in this step/);
    expect(computerExec).not.toHaveBeenCalled();
  });

  it("is a no-op when the advertised set is null (no narrowing)", async () => {
    const { tools, computerExec } = makeTools();
    const gated = gateToolsToAdvertisedSubset(tools, () => null);
    await expect(
      (gated.computer.execute as Function)({}, {}),
    ).resolves.toBe("computer-result");
    expect(computerExec).toHaveBeenCalledTimes(1);
  });

  it("reads the advertised set at execute time (per-step)", async () => {
    const { tools, computerExec } = makeTools();
    let advertised: ReadonlySet<string> | null = new Set(["search"]);
    const gated = gateToolsToAdvertisedSubset(tools, () => advertised);
    await expect(
      (gated.computer.execute as Function)({}, {}),
    ).rejects.toThrow();
    // Widget rendered -> computer advertised on the next step.
    advertised = new Set(["search", "computer"]);
    await expect(
      (gated.computer.execute as Function)({}, {}),
    ).resolves.toBe("computer-result");
    expect(computerExec).toHaveBeenCalledTimes(1);
  });

  it("passes through tools that have no execute (e.g. app-provided aliases)", () => {
    const aliasTool = { description: "alias" };
    const gated = gateToolsToAdvertisedSubset(
      { alias: aliasTool },
      () => new Set<string>(),
    );
    expect(gated.alias).toBe(aliasTool);
  });
});
