import { describe, expect, it, vi } from "vitest";
import {
  displayGeometryFor,
  resizeHostedDisplay,
  type DisplayResizeDeps,
} from "../display-resize";

const AT = { width: 1024, height: 768 };
const TO = { width: 1400, height: 900 };

function harness(over: Partial<DisplayResizeDeps> = {}) {
  const commands: string[] = [];
  const pages: Array<{ width: number; height: number }> = [];
  const encoders: Array<{ width: number; height: number }> = [];
  const deps: DisplayResizeDeps = {
    display: ":0",
    run: async (command) => {
      commands.push(command);
      return { exitCode: 0 };
    },
    resizePage: async (size) => {
      pages.push(size);
    },
    restartEncoder: async (size) => {
      encoders.push(size);
    },
    ...over,
  };
  return { deps, commands, pages, encoders };
}

describe("displayGeometryFor", () => {
  it("is the page, at the device pixel ratio", () => {
    expect(displayGeometryFor({ width: 1024, height: 768 })).toEqual({
      width: 1024,
      height: 768,
      depth: 24,
    });
    expect(
      displayGeometryFor({ width: 1024, height: 768 }, { deviceScaleFactor: 2 }),
    ).toMatchObject({ width: 2048, height: 1536 });
  });

  it("rounds an odd dimension UP, on the display and not the page", () => {
    // H.264's 4:2:0 chroma sampling cannot represent an odd dimension, so an
    // encoder handed 1401 either refuses or silently crops a column — and a
    // cropped column is a coordinate space that disagrees with the page by one
    // pixel forever. Rounding the DISPLAY costs one row and column of padding
    // nothing draws in; rounding the PAGE would give somebody who dragged a
    // panel to an odd width a page one pixel narrower than their panel.
    expect(displayGeometryFor({ width: 1401, height: 901 })).toMatchObject({
      width: 1402,
      height: 902,
    });
  });

  it("keeps an odd size even after scaling", () => {
    expect(
      displayGeometryFor({ width: 701, height: 401 }, { deviceScaleFactor: 1.5 }),
    ).toMatchObject({ width: 1052, height: 602 });
  });
});

describe("resizing a hosted display", () => {
  it("takes the display, the page and the encoder, in that order", async () => {
    // The display first, because a kiosk window told to fill a screen that has
    // not grown yet fills the old one. The encoder last, because its restart
    // mints the keyframe every watcher sees first, and a keyframe of a page
    // mid-reflow is a valid frame of the wrong thing.
    const order: string[] = [];
    const h = harness({
      run: async (command) => {
        order.push(`display:${command}`);
        return { exitCode: 0 };
      },
      resizePage: async () => {
        order.push("page");
      },
      restartEncoder: async () => {
        order.push("encoder");
      },
    });
    await expect(resizeHostedDisplay(h.deps, TO, AT)).resolves.toEqual({
      ok: true,
      applied: TO,
    });
    expect(order[0]).toContain("display:xrandr");
    expect(order.slice(1)).toEqual(["page", "encoder"]);
  });

  it("sets the framebuffer rather than selecting a mode", async () => {
    // `-s` only picks among the modes the server advertises, and Xvnc
    // advertises one. `--fb` is the RandR operation it implements for this.
    const h = harness();
    await resizeHostedDisplay(h.deps, TO, AT);
    expect(h.commands[0]).toBe("xrandr --display :0 --fb 1400x900");
  });

  it("puts everything back when the display refuses", async () => {
    const h = harness({
      run: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 1, stderr: "cannot set fb" })
        .mockResolvedValue({ exitCode: 0 }),
    });
    const outcome = await resizeHostedDisplay(h.deps, TO, AT);
    expect(outcome).toMatchObject({ ok: false, restored: true });
    expect(outcome).toHaveProperty("reason", "cannot set fb");
    // The page and the encoder were never taken to the new size...
    expect(h.pages).not.toContainEqual(TO);
    // ...and were put back to the old one.
    expect(h.pages).toEqual([AT]);
    expect(h.encoders).toEqual([AT]);
  });

  it("puts the display back when the PAGE refuses", async () => {
    // A display at one size with a page laid out for another is a browser
    // whose every coordinate is wrong, silently.
    const h = harness({
      resizePage: async (size) => {
        if (size.width === TO.width) throw new Error("the renderer is gone");
      },
    });
    const outcome = await resizeHostedDisplay(h.deps, TO, AT);
    expect(outcome).toMatchObject({ ok: false, restored: true });
    expect(h.commands).toEqual([
      "xrandr --display :0 --fb 1400x900",
      "xrandr --display :0 --fb 1024x768",
    ]);
  });

  it("says so when it cannot even restore", async () => {
    // The one genuinely bad state: the display is at a size nothing else
    // agrees with, and the caller's job is to stop publishing dimensions.
    const h = harness({
      run: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValue({ exitCode: 1, stderr: "no" }),
      resizePage: async () => {
        throw new Error("gone");
      },
    });
    await expect(resizeHostedDisplay(h.deps, TO, AT)).resolves.toMatchObject({
      ok: false,
      restored: false,
    });
  });

  it("refuses a display name that is not one", async () => {
    // This builds a shell command. A display name is `:0`-shaped or it is not
    // a display name.
    const h = harness({ display: ":0; rm -rf /" });
    const outcome = await resizeHostedDisplay(h.deps, TO, AT);
    expect(outcome).toMatchObject({ ok: false, restored: true });
    expect(h.commands).toEqual([]);
  });

  it("survives a shell that throws rather than exiting", async () => {
    const h = harness({
      run: async () => {
        throw new Error("sandbox gone");
      },
    });
    await expect(resizeHostedDisplay(h.deps, TO, AT)).resolves.toMatchObject({
      ok: false,
      restored: false,
    });
  });

  it("works on a box with no encoder and no page adapter", async () => {
    // Both are optional: a box without ffmpeg answers `video_unavailable` and
    // every watcher falls back to JPEG, which is a supported state.
    const h = harness({});
    delete (h.deps as { restartEncoder?: unknown }).restartEncoder;
    delete (h.deps as { resizePage?: unknown }).resizePage;
    await expect(resizeHostedDisplay(h.deps, TO, AT)).resolves.toEqual({
      ok: true,
      applied: TO,
    });
  });

  it("scales the display by the device pixel ratio", async () => {
    const h = harness({ deviceScaleFactor: 2 });
    await resizeHostedDisplay(h.deps, TO, AT);
    expect(h.commands[0]).toBe("xrandr --display :0 --fb 2800x1800");
    // The PAGE keeps its logical size — the scale is a property of the
    // display, and the model's coordinates are CSS pixels.
    expect(h.pages).toEqual([TO]);
  });
});
