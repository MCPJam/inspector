import { afterEach, expect, it, vi } from "vitest";
import { createImagePresenter } from "../image-presenter";

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const loads: Array<{
    src: string;
    onload: null | (() => void);
    onerror: null | (() => void);
  }> = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = null;
      onerror = null;
      constructor() {
        loads.push(this);
      }
    },
  );
  const painted: string[] = [];
  const presenter = createImagePresenter((_image, frame) => {
    painted.push(frame.src);
  });
  return { loads, painted, presenter };
}

it("bounds slow decoding to one active load and the newest pending picture", () => {
  const { loads, painted, presenter } = setup();
  for (let i = 1; i <= 100; i++) presenter.push({ src: String(i) });
  expect(loads).toHaveLength(1);
  loads[0].onload!();
  expect(painted).toEqual(["1"]);
  expect(loads).toHaveLength(2);
  expect(loads[1].src).toBe("100");
  loads[1].onload!();
  expect(painted).toEqual(["1", "100"]);
});

it("continues after a failed image and ignores a decode completed after clear", () => {
  const { loads, painted, presenter } = setup();
  presenter.push({ src: "bad" });
  presenter.push({ src: "good" });
  loads[0].onerror!();
  const late = loads[1].onload!;
  presenter.clear();
  late();
  expect(painted).toEqual([]);
  presenter.push({ src: "new session" });
  loads[2].onload!();
  expect(painted).toEqual(["new session"]);
});
