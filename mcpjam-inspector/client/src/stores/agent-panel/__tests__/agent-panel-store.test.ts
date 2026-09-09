import { afterEach, expect, it, vi } from "vitest";
const originalWidth = window.innerWidth;
afterEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalWidth,
  });
});
it.each([700, 420])(
  "preserves a desired width of %s when loaded on a narrow viewport",
  async (width) => {
    vi.resetModules();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    localStorage.setItem("mcpjam:agent-panel:v1", JSON.stringify({ width }));
    const { useAgentPanelStore, clampAgentPanelWidth } =
      await import("../agent-panel-store");
    expect(useAgentPanelStore.getState().width).toBe(width);
    expect(clampAgentPanelWidth(width)).toBe(351);
    window.dispatchEvent(new Event("resize"));
    useAgentPanelStore.getState().setOpen(true);
    expect(
      JSON.parse(localStorage.getItem("mcpjam:agent-panel:v1")!).width,
    ).toBe(width);
    expect(
      clampAgentPanelWidth(useAgentPanelStore.getState().width, 1440),
    ).toBe(width);
  },
);
