import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { EffortControl } from "../effort-control";

function renderControl(props: Partial<Parameters<typeof EffortControl>[0]>) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <EffortControl options={["low", "high"]} onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return onChange;
}

describe("EffortControl", () => {
  it("renders nothing when the capability is unknown and nothing is saved", () => {
    renderControl({ options: [] });
    expect(screen.queryByTestId("effort-control-trigger")).toBeNull();
  });

  it("shows a terse level chip and picks a level from the popover", async () => {
    const onChange = renderControl({ value: "high" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent("High");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("radio", { name: "Low" }));
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("clears back to the default level", async () => {
    const onChange = renderControl({ value: "high" });
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    await userEvent.click(
      await screen.findByRole("radio", { name: "Default" }),
    );
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("badges a saved effort the catalog no longer lists", () => {
    renderControl({ options: ["low", "high"], value: "max" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent("no longer supported");
    expect(trigger).toHaveAttribute("data-stale", "true");
  });

  it("still shows a saved effort when the capability list is empty", () => {
    renderControl({ options: [], value: "high" });
    expect(screen.getByTestId("effort-control-trigger")).toHaveAttribute(
      "data-stale",
      "true",
    );
  });

  it("is inert with a reason when disabled", async () => {
    const onChange = renderControl({
      value: "low",
      disabled: true,
      disabledReason: "Pick a saved model first",
    });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toBeDisabled();
    await userEvent.click(trigger);
    expect(screen.queryByRole("radio", { name: "Low" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("names the group and picks a level from the keyboard", async () => {
    const onChange = renderControl({ value: "high" });
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    const group = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    expect(group).toBeInTheDocument();
    const low = screen.getByRole("radio", { name: "Low" });
    expect(screen.getByRole("radio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    low.focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("low");
  });
});
