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
