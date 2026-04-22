import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaygroundSuitesExecutionsTabs } from "../playground-suites-executions-tabs";

describe("PlaygroundSuitesExecutionsTabs", () => {
  it("calls onChange when a tab is activated", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <PlaygroundSuitesExecutionsTabs value="suites" onChange={onChange} />,
    );

    await user.click(screen.getByRole("tab", { name: "Executions" }));
    expect(onChange).toHaveBeenCalledWith("executions");
  });

  it("marks the active tab with aria-selected", () => {
    render(
      <PlaygroundSuitesExecutionsTabs value="executions" onChange={vi.fn()} />,
    );

    expect(screen.getByRole("tab", { name: "Executions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});
