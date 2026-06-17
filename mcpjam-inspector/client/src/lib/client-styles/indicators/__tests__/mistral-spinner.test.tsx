import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MistralSpinnerIndicator } from "../mistral-spinner";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("MistralSpinnerIndicator", () => {
  it("renders Le Chat's five-square loader and shimmering 'Thinking' label", () => {
    render(<MistralSpinnerIndicator />);

    const wrapper = screen.getByTestId("loading-indicator-mistral");
    expect(wrapper).toHaveTextContent("Thinking");

    // The morphing loader: a 200×200 SVG holding five animated squares.
    const loader = screen.getByTestId("loading-indicator-mistral-loader");
    expect(loader.tagName.toLowerCase()).toBe("svg");
    expect(loader).toHaveAttribute("viewBox", "0 0 200 200");
    expect(loader.querySelectorAll("rect")).toHaveLength(5);
    expect(loader.querySelectorAll("animateTransform")).toHaveLength(5);
    // Mistral's orange→amber ramp, verbatim from the capture.
    const fills = Array.from(loader.querySelectorAll("rect")).map((r) =>
      r.getAttribute("fill")
    );
    expect(fills).toEqual([
      "#fa500f",
      "#ff8205",
      "#ffaf01",
      "#ff8205",
      "#fa500f",
    ]);
  });

  it("binds the mistral-shimmer-text animation hook via class", () => {
    // Animation resolves from CSS in `index.css` — assert the class wiring
    // so a refactor can't silently drop the keyframe binding.
    render(<MistralSpinnerIndicator />);
    expect(
      screen
        .getByTestId("loading-indicator-mistral-label")
        .classList.contains("mistral-shimmer-text")
    ).toBe(true);
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <MistralSpinnerIndicator className="custom-test-class" />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region and mirrors the verb sr-only", () => {
    const { container } = render(<MistralSpinnerIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The visible label is masked transparent by the shimmer, so the verb
    // is also mirrored sr-only for screen readers.
    expect(container.textContent).toContain("Thinking");
  });

  it("defaults the label to data-theme='dark' when no chatbox host theme is mounted", () => {
    render(<MistralSpinnerIndicator />);
    expect(
      screen.getByTestId("loading-indicator-mistral-label").dataset.theme
    ).toBe("dark");
  });

  it("switches the label to data-theme='light' under a light chatbox host theme", () => {
    render(
      <ChatboxHostThemeProvider value="light">
        <MistralSpinnerIndicator />
      </ChatboxHostThemeProvider>
    );
    expect(
      screen.getByTestId("loading-indicator-mistral-label").dataset.theme
    ).toBe("light");
  });
});
