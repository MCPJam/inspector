import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunInsightBand } from "../run-insight-band";

describe("RunInsightBand", () => {
  it("shows the summary collapsed and reveals the content on expand", async () => {
    const user = userEvent.setup();
    render(
      <RunInsightBand
        summary={<span>Judge 4/9 meet goal · 1 disagrees with pass/fail</span>}
      >
        <div>full insight cards</div>
      </RunInsightBand>,
    );
    // Collapsed: summary visible, content hidden.
    expect(
      screen.getByText(/4\/9 meet goal · 1 disagrees/),
    ).toBeInTheDocument();
    expect(screen.queryByText("full insight cards")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /expand run insights/i });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("full insight cards")).toBeInTheDocument();
  });

  it("stays neutral by default and colors only on higher severity", () => {
    const { rerender, container } = render(
      <RunInsightBand summary={<span>AI insights</span>}>
        <div>cards</div>
      </RunInsightBand>,
    );
    expect(container.querySelector("[data-severity]")).toHaveAttribute(
      "data-severity",
      "neutral",
    );
    rerender(
      <RunInsightBand summary={<span>AI insights</span>} severity="warn">
        <div>cards</div>
      </RunInsightBand>,
    );
    const band = container.querySelector("[data-severity]");
    expect(band).toHaveAttribute("data-severity", "warn");
    expect(band?.className).toContain("border-l-warning");
  });

  it("can default to open", () => {
    render(
      <RunInsightBand summary={<span>AI insights</span>} defaultOpen>
        <div>cards</div>
      </RunInsightBand>,
    );
    expect(screen.getByText("cards")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collapse run insights/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});
