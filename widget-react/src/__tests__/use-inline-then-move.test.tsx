import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInlineThenMove } from "../use-inline-then-move";

afterEach(cleanup);

const CLAUDE = { hints: "ui", start: "inline-then-move" } as const;
const OPENAI = { hints: "openai/ui", start: "hint-first" } as const;

type Args = Parameters<typeof useInlineThenMove>[0];

function setup(overrides: Partial<Args> = {}) {
  const moveToPanel = vi.fn();
  const revealPanel = vi.fn();
  const initial: Args = {
    behavior: CLAUDE,
    ready: true,
    toolState: "output-available",
    toolOutput: { content: [{ type: "text", text: "ok" }] },
    modes: ["inline", "fullscreen"],
    preferred: "fullscreen",
    panelAvailable: true,
    fullscreen: false,
    placed: false,
    preferInline: () => false,
    moveToPanel,
    revealPanel,
    ...overrides,
  };
  const view = renderHook((args: Args) => useInlineThenMove(args), {
    initialProps: initial,
  });
  const rerender = (change: Partial<Args>) =>
    view.rerender({ ...initial, ...change });
  return { ...view, rerender, moveToPanel, revealPanel };
}

describe("the one move to the side panel", () => {
  it("moves an App that prefers full screen once it has started and its result is in", () => {
    const { moveToPanel, rerender } = setup();
    expect(moveToPanel).toHaveBeenCalledTimes(1);
    // It never tries again, even after leaving the panel.
    rerender({ fullscreen: true });
    rerender({ fullscreen: false, preferred: "fullscreen" });
    expect(moveToPanel).toHaveBeenCalledTimes(1);
  });

  it("waits for the App to start and for its tool call to return", () => {
    const { moveToPanel, rerender } = setup({
      ready: false,
      toolState: "input-available",
    });
    rerender({ ready: true, toolState: "input-available" });
    expect(moveToPanel).not.toHaveBeenCalled();
    rerender({ ready: true, toolState: "output-available" });
    expect(moveToPanel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no preference", { preferred: undefined }],
    ["an inline preference", { preferred: "inline" }],
    [
      "an error result (isError)",
      { toolOutput: { isError: true, content: [] } },
    ],
    ["a failed tool call", { toolState: "output-error" }],
    ["no side panel (compare, mobile preview)", { panelAvailable: false }],
    ["an inline-only App", { modes: ["inline"] as const }],
    ["an App that declared [] or pip", { modes: ["inline"] as const }],
    ["an App already full screen", { fullscreen: true }],
    ["a person who sent it back inline", { preferInline: () => true }],
    ["OpenAI's rules", { behavior: OPENAI }],
    ["Display modes off", { behavior: undefined }],
  ])("stays put with %s", (_name, change) => {
    const { moveToPanel } = setup(change);
    expect(moveToPanel).not.toHaveBeenCalled();
  });

  it("tries only when the result arrives: a panel that appears later doesn't move it", () => {
    const { moveToPanel, rerender } = setup({ panelAvailable: false });
    rerender({ panelAvailable: true });
    expect(moveToPanel).not.toHaveBeenCalled();
  });
});

describe("startMode", () => {
  it("sends a full-screen-only App to full screen only where a side panel holds it", () => {
    const withPanel = setup({ preferred: undefined }).result.current;
    expect(withPanel.startMode(["fullscreen"])).toBe("fullscreen");
    expect(withPanel.startMode(["inline", "fullscreen"])).toBe("inline");
    expect(withPanel.startMode(["inline"])).toBe("inline");
    const without = setup({ preferred: undefined, panelAvailable: false })
      .result.current;
    expect(without.startMode(["fullscreen"])).toBeUndefined();
  });

  it("leaves other display behaviors to the renderer", () => {
    for (const behavior of [OPENAI, undefined])
      expect(
        setup({ behavior }).result.current.startMode(["fullscreen"]),
      ).toBeUndefined();
  });
});

describe("the card for a full-screen-only App", () => {
  it("shows in the conversation while the App sits in the side panel", () => {
    const { result, rerender, revealPanel } = setup({
      modes: ["fullscreen"],
      placed: true,
      fullscreen: true,
    });
    expect(result.current.panelCard).toBe(true);
    result.current.showPanel();
    expect(revealPanel).toHaveBeenCalledTimes(1);
    rerender({ modes: ["fullscreen"], placed: false, fullscreen: true });
    expect(result.current.panelCard).toBe(false);
  });

  it("doesn't show for an App that can also be inline, or under OpenAI's rules", () => {
    expect(
      setup({ placed: true, fullscreen: true }).result.current.panelCard,
    ).toBe(false);
    expect(
      setup({ behavior: OPENAI, modes: ["fullscreen"], placed: true }).result
        .current.panelCard,
    ).toBe(false);
  });
});
