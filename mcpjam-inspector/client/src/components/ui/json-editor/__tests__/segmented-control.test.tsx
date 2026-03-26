import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../segmented-control";

describe("SegmentedControl", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ] as const;

  it("uses compact padding by default (sm)", () => {
    const { container } = render(
      <SegmentedControl
        value="a"
        onChange={vi.fn()}
        options={[...options]}
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("p-0.5");
  });

  it("uses roomier padding when size is default", () => {
    const { container } = render(
      <SegmentedControl
        size="default"
        value="a"
        onChange={vi.fn()}
        options={[...options]}
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("p-1");
  });
});
