import { afterEach, describe, expect, it, vi } from "vitest";
import { createTourDriver } from "../driver";
import type { GhostCursorHandle } from "../ghost-cursor";

function fakeCursor(): GhostCursorHandle {
  return {
    show: vi.fn(),
    hide: vi.fn(),
    moveTo: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    position: () => ({ x: 0, y: 0 }),
  };
}

describe("createTourDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scrolls the target into view before the cursor moves to it", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const order: string[] = [];
    const root = document.createElement("div");
    const target = document.createElement("button");
    target.setAttribute("data-tour-anchor", "case-run");
    target.scrollIntoView = vi.fn(() => {
      order.push("scroll");
    });
    root.append(target);
    const cursor = fakeCursor();
    vi.mocked(cursor.moveTo).mockImplementation(async () => {
      order.push("move");
    });

    const driver = createTourDriver({
      root,
      cursor,
      run: { cancelled: false },
      reducedMotion: false,
    });
    await driver.moveTo("case-run");

    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(order).toEqual(["scroll", "move"]);
  });
});
