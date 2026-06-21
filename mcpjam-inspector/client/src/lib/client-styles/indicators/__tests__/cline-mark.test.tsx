import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClineMarkIndicator } from "../cline-mark";

describe("ClineMarkIndicator", () => {
  it("uses unique SVG mask ids per instance", () => {
    const { container } = render(
      <>
        <ClineMarkIndicator />
        <ClineMarkIndicator />
      </>,
    );

    const masks = [...container.querySelectorAll("mask")];
    const maskIds = masks.map((mask) => mask.id);

    expect(maskIds).toHaveLength(2);
    expect(new Set(maskIds).size).toBe(2);
    expect(maskIds.every((id) => id.startsWith("cline-indicator-eyes-"))).toBe(
      true,
    );

    const maskedGroups = [...container.querySelectorAll("g[mask]")];
    expect(maskedGroups.map((group) => group.getAttribute("mask"))).toEqual(
      maskIds.map((id) => `url(#${id})`),
    );
  });
});
