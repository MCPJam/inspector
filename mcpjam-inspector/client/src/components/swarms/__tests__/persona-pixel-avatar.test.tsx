import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PERSONA_PIXEL_PALETTE_COUNT,
  PERSONA_PIXEL_SHAPE_COUNT,
  PersonaPixelAvatar,
  resolvePersonaPixelLook,
  resolvePersonaPixelVariant,
  wrapPersonaPixelIndex,
} from "../persona-pixel-avatar";

describe("PersonaPixelAvatar", () => {
  it("picks a stable shape + palette from the seed", () => {
    const a = resolvePersonaPixelVariant("persona-1");
    const b = resolvePersonaPixelVariant("persona-1");
    const c = resolvePersonaPixelVariant("persona-2");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("honors explicit shape/palette overrides over the seed", () => {
    const seeded = resolvePersonaPixelVariant("persona-bob");
    const overrideShape =
      (seeded.shapeIndex + 1) % PERSONA_PIXEL_SHAPE_COUNT;
    const overridePalette =
      (seeded.paletteIndex + 2) % PERSONA_PIXEL_PALETTE_COUNT;

    expect(
      resolvePersonaPixelLook("persona-bob", {
        shapeIndex: overrideShape,
        paletteIndex: overridePalette,
      }),
    ).toEqual({
      shapeIndex: overrideShape,
      paletteIndex: overridePalette,
    });

    render(
      <PersonaPixelAvatar
        seed="persona-bob"
        shapeIndex={overrideShape}
        paletteIndex={overridePalette}
      />,
    );
    const el = screen.getByTestId("persona-pixel-avatar");
    expect(el.getAttribute("data-shape")).toBe(String(overrideShape));
    expect(el.getAttribute("data-palette")).toBe(String(overridePalette));
  });

  it("falls back to seed when overrides are unset", () => {
    const seeded = resolvePersonaPixelVariant("persona-bob");
    expect(resolvePersonaPixelLook("persona-bob")).toEqual(seeded);
    expect(
      resolvePersonaPixelLook("persona-bob", {
        shapeIndex: null,
        paletteIndex: null,
      }),
    ).toEqual(seeded);
  });

  it("wraps look indices into range", () => {
    expect(wrapPersonaPixelIndex(-1, 6)).toBe(5);
    expect(wrapPersonaPixelIndex(6, 6)).toBe(0);
    expect(wrapPersonaPixelIndex(2, 6)).toBe(2);
  });

  it("renders an SVG sprite with the resolved variant attrs", () => {
    const { shapeIndex, paletteIndex } =
      resolvePersonaPixelVariant("persona-bob");
    render(<PersonaPixelAvatar seed="persona-bob" />);
    const el = screen.getByTestId("persona-pixel-avatar");
    expect(el.getAttribute("data-shape")).toBe(String(shapeIndex));
    expect(el.getAttribute("data-palette")).toBe(String(paletteIndex));
    expect(el.querySelector("svg")).toBeTruthy();
  });

  it("renders identical SVG markup for the same seed + indices", () => {
    const { container: a } = render(
      <PersonaPixelAvatar seed="twin-seed" shapeIndex={4} paletteIndex={1} />,
    );
    const markupA = a.querySelector("svg")?.innerHTML;
    const { container: b } = render(
      <PersonaPixelAvatar seed="twin-seed" shapeIndex={4} paletteIndex={1} />,
    );
    const markupB = b.querySelector("svg")?.innerHTML;
    expect(markupA).toBeTruthy();
    expect(markupA).toBe(markupB);
  });

  it("varies SVG markup across seeds within the same family/mineral", () => {
    const { container: a } = render(
      <PersonaPixelAvatar seed="seed-alpha" shapeIndex={0} paletteIndex={0} />,
    );
    const { container: b } = render(
      <PersonaPixelAvatar seed="seed-omega" shapeIndex={0} paletteIndex={0} />,
    );
    expect(a.querySelector("svg")?.innerHTML).not.toBe(
      b.querySelector("svg")?.innerHTML,
    );
  });

  it("sets data-state from the state prop", () => {
    render(<PersonaPixelAvatar seed="persona-bob" state="running" />);
    expect(
      screen.getByTestId("persona-pixel-avatar").getAttribute("data-state"),
    ).toBe("running");
  });
});

/**
 * BB-160. The Swarm Describe frame's hero graphic has one arm up, so the
 * generator grew a `wave` pose. It shares the arm block with every avatar in
 * the product, and the sprite is procedural off a seeded rng, so the risk worth
 * testing is not "does the arm move" — it is whether anything ELSE moved.
 */
describe("PersonaPixelAvatar — wave pose", () => {
  const sprite = (props: {
    shapeIndex: number;
    pose?: "stand" | "wave";
    seed?: string;
  }) =>
    render(
      <PersonaPixelAvatar
        seed="swarm-hero-lapis"
        paletteIndex={3}
        {...props}
      />,
    ).container.querySelector("svg")!;

  /** Body cells only — the head sits in its own animated `<g>`. */
  const leftmostBodyColumn = (svg: SVGElement) =>
    Math.min(
      ...Array.from(svg.querySelectorAll(":scope > rect")).map((r) =>
        Number(r.getAttribute("x")),
      ),
    );

  /**
   * Head cells, minus the glow sensor — at the default state it is the only
   * head rect carrying a class. The sensor is placed after every cell has been
   * coloured, so the extra cells an arm adds move it legitimately; the cells
   * themselves are laid out before any of that and hold still.
   */
  const headCells = (svg: SVGElement) =>
    Array.from(svg.querySelectorAll("g rect:not([class])")).map(
      (r) => `${r.getAttribute("x")},${r.getAttribute("y")}`,
    );

  it("stands by default, so no existing avatar is touched", () => {
    expect(sprite({ shapeIndex: 0 }).innerHTML).toBe(
      sprite({ shapeIndex: 0, pose: "stand" }).innerHTML,
    );
  });

  it("moves nothing but the arms — an armless family is byte-identical", () => {
    // Stele and Tripod carry no `arms`, so `wave` has nothing to raise. If
    // their markup ever diverges, the pose has reached past the arm block or
    // shifted the rng the rest of the sprite is drawn from.
    for (const shapeIndex of [1, 3]) {
      expect(sprite({ shapeIndex }).innerHTML).toBe(
        sprite({ shapeIndex, pose: "wave" }).innerHTML,
      );
    }
  });

  it("puts the raised hand further out than the standing silhouette", () => {
    expect(
      leftmostBodyColumn(sprite({ shapeIndex: 0, pose: "wave" })),
    ).toBeLessThan(leftmostBodyColumn(sprite({ shapeIndex: 0 })));
  });

  it("forces the arms without spending rng the standing sprite skips", () => {
    // A wave has to wave, so on the 15% of seeds whose arm roll comes up empty
    // it draws arms the roll refused. That forced branch is where a stray draw
    // hides: rolling for an arm length there would shift every draw after it.
    // Head cells witness the shift — they are laid out downstream of the arm
    // block and nowhere near the raised hand, so they move only if the stream
    // did. Every family reaches the arm roll on the same draw (five size
    // draws, two chipped corners, one leg offset), so this seed misses it for
    // all four armed ones: Brute, Runt, Warden, Waif.
    const seed = "missed-arm-roll";
    for (const shapeIndex of [0, 2, 4, 5]) {
      expect(headCells(sprite({ seed, shapeIndex, pose: "wave" }))).toEqual(
        headCells(sprite({ seed, shapeIndex })),
      );
    }
  });

  it("records what the generator emits for the standing hero", () => {
    // The anchor. Everything above compares two renders of the same generator,
    // so a stray draw in the shared path shifts both sides and stays invisible.
    // These are what it actually produced when the pose landed, and they should
    // change only alongside a deliberate change to the generator.
    const rects = Array.from(
      sprite({ shapeIndex: 0 }).querySelectorAll("rect"),
    );
    expect(rects).toHaveLength(61);

    const census: Record<string, number> = {};
    for (const rect of rects) {
      const fill = rect.getAttribute("fill")!;
      census[fill] = (census[fill] ?? 0) + 1;
    }
    // Lapis dark / mid / light / glow, and the ground shadow. The census moves
    // on a geometry change and on the per-cell dark↔mid flip alike, which a
    // bare cell count would miss.
    expect(census).toEqual({
      "#1d2740": 16,
      "#334570": 26,
      "#54679b": 15,
      "#9ec1f0": 3,
      "#000": 1,
    });
  });
});
