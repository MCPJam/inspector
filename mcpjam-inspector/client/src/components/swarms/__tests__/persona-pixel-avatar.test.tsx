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
});
