import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { N8nMarkIndicator } from "../n8n-mark";

describe("N8nMarkIndicator", () => {
  it("renders three n8n-red dots with the shared wave classes", () => {
    const { getByTestId, container } = render(<N8nMarkIndicator />);

    const root = getByTestId("loading-indicator-n8n");
    expect(root).toHaveClass("n8n-mark-indicator");

    const dots = container.querySelectorAll(".n8n-mark-indicator__dot");
    expect(dots).toHaveLength(3);
    expect(dots[0]).toHaveClass("n8n-mark-indicator__dot--1");
    expect(dots[1]).toHaveClass("n8n-mark-indicator__dot--2");
    expect(dots[2]).toHaveClass("n8n-mark-indicator__dot--3");
    // n8n red is applied via CSS (.n8n-mark-indicator__dot), not Tailwind
    // bg-primary — assert the brand class wiring so a refactor can't silently
    // drop the recolor back to MCPJam's primary.
    expect(dots[0]).not.toHaveClass("bg-primary");
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <N8nMarkIndicator className="custom-test-class" />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region and mirrors the verb sr-only", () => {
    const { container } = render(<N8nMarkIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    expect(container.textContent).toContain("Thinking");
  });
});
