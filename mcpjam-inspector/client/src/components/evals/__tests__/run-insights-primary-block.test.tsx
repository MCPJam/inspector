import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunInsightsPrimaryBlock } from "../run-insights-primary-block";

const noop = () => {};

describe("RunInsightsPrimaryBlock", () => {
  it("uses insight glow and left accent classes in embedded mode", () => {
    const { container } = render(
      <RunInsightsPrimaryBlock
        summary={null}
        pending={false}
        requested={false}
        failedGeneration={false}
        error={null}
        onRetry={noop}
        embedded
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ai-insight-glow");
    expect(root.className).toContain("border-l-primary");
    expect(
      container.querySelectorAll(".ai-sparkle-icon").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders standalone card with Run insights title row and sparkle styling", () => {
    const { container } = render(
      <RunInsightsPrimaryBlock
        summary="Summary text"
        pending={false}
        requested={false}
        failedGeneration={false}
        error={null}
        onRetry={noop}
        embedded={false}
      />,
    );

    expect(screen.getByText("Summary text")).toBeInTheDocument();
    expect(screen.getByText("Run insights")).toBeInTheDocument();
    expect(
      container.querySelectorAll(".ai-sparkle-icon").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows Retry when generation failed", () => {
    render(
      <RunInsightsPrimaryBlock
        summary={null}
        pending={false}
        requested={false}
        failedGeneration
        error={null}
        onRetry={vi.fn()}
        embedded
      />,
    );

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
