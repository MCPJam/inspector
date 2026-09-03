/**
 * The grading peek is the always-visible expected/observed pair. Empty input
 * must not leave an empty "Graded against" box on a passed or unread run.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RunGradingPeek } from "../run-grading-peek";

describe("RunGradingPeek", () => {
  it("hides when there is nothing to compare", () => {
    const { container } = render(
      <RunGradingPeek expected={[]} observed={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the expected call that was never observed", () => {
    render(
      <RunGradingPeek
        expected={["create_view", "export_to_excalidraw"]}
        observed={["create_view"]}
      />,
    );

    const peek = screen.getByTestId("run-grading-peek");
    expect(peek).toHaveTextContent("Graded against");
    expect(peek).toHaveTextContent("create_view");
    expect(screen.getByText("never called").closest("li")).toHaveTextContent(
      "export_to_excalidraw never called",
    );
  });
});
