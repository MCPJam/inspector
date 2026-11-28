import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getHostLogoSrc, UNKNOWN_HOST_LOGO } from "@/lib/host-ui-metadata";
import { JourneyHostLogoMark } from "../journey-host-logo";

describe("JourneyHostLogoMark", () => {
  it("draws a renamed client's logo from its saved style", () => {
    const { container } = render(
      <JourneyHostLogoMark label="Acme bot" hostStyle="codex" />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      getHostLogoSrc("codex"),
    );
  });

  it("falls back to the label without a saved style", () => {
    const { container } = render(<JourneyHostLogoMark label="Acme bot" />);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      UNKNOWN_HOST_LOGO,
    );
  });
});
