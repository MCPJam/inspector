import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { effortSlider, pickEffort } from "@/test/effort";
import { EffortControl, reasoningEffortShortLabel } from "../effort-control";

function renderControl(props: Partial<Parameters<typeof EffortControl>[0]>) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <EffortControl options={["low", "high"]} onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return onChange;
}

async function openPopover() {
  await userEvent.click(screen.getByTestId("effort-control-trigger"));
  return effortSlider();
}

describe("EffortControl", () => {
  it("renders nothing when the capability is unknown and nothing is saved", () => {
    renderControl({ options: [] });
    expect(screen.queryByTestId("effort-control-trigger")).toBeNull();
  });

  it("shows the short level on the chip", () => {
    renderControl({ options: ["low", "medium", "high"], value: "medium" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent("Med");
    expect(trigger).not.toHaveTextContent("Medium");
    // The accessible name keeps the full level.
    expect(trigger).toHaveAccessibleName("Reasoning effort: Medium");
  });

  it("has a short label for every level", () => {
    expect(
      (
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
      ).map(reasoningEffortShortLabel),
    ).toEqual(["None", "Min", "Low", "Med", "High", "X-High", "Max"]);
  });

  it("opens a slider popover with the level header, explainer and Faster/Smarter ends", async () => {
    renderControl({ value: "high" });
    const slider = await openPopover();
    expect(screen.getByTestId("effort-control-header")).toHaveTextContent(
      "Effort High",
    );
    expect(
      screen.getByRole("button", { name: "About reasoning effort" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Faster")).toBeInTheDocument();
    expect(screen.getByText("Smarter")).toBeInTheDocument();
    // One stop per option: Default, then each level low to high.
    expect(screen.getByTestId("effort-stop-default")).toBeInTheDocument();
    expect(screen.getByTestId("effort-stop-low")).toBeInTheDocument();
    expect(screen.getByTestId("effort-stop-high")).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "2");
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    expect(slider).toHaveAttribute("aria-valuetext", "High");
  });

  it("steps through levels with the arrow keys", async () => {
    const onChange = renderControl({ value: "high" });
    const slider = await openPopover();
    act(() => slider.focus());
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("low");
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
    expect(screen.getByTestId("effort-control-header")).toHaveTextContent(
      "Effort Low",
    );
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("high");
  });

  it("sends undefined for Default, never the default level's value", async () => {
    const onChange = renderControl({
      options: ["low", "medium", "high"],
      value: "low",
      defaultLevel: "medium",
    });
    const slider = await openPopover();
    act(() => slider.focus());
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByTestId("effort-control-header")).toHaveTextContent(
      "Effort Default",
    );
  });

  it("picks a level with the test helper", async () => {
    const onChange = renderControl({ options: ["low", "medium", "high"] });
    await openPopover();
    await pickEffort("Medium");
    expect(onChange).toHaveBeenLastCalledWith("medium");
  });

  it("puts the Default caption under the provider default level", async () => {
    renderControl({ options: ["low", "medium", "high"], defaultLevel: "high" });
    await openPopover();
    expect(screen.getByTestId("effort-default-caption")).toHaveAttribute(
      "data-stop",
      "high",
    );
  });

  it("puts the Default caption under the Default stop when the default is unknown or not offered", async () => {
    renderControl({ options: ["low", "high"], defaultLevel: "medium" });
    await openPopover();
    expect(screen.getByTestId("effort-default-caption")).toHaveAttribute(
      "data-stop",
      "default",
    );
  });

  it("suffix variant shows only the middle-dot short level and opens the same popover", async () => {
    const onChange = renderControl({
      variant: "suffix",
      options: ["low", "medium", "high"],
      value: "medium",
    });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger.textContent).toBe("· Med");
    expect(trigger).toHaveAccessibleName("Reasoning effort: Medium");
    await userEvent.click(trigger);
    await pickEffort("High");
    expect(onChange).toHaveBeenLastCalledWith("high");
  });

  it("suffix variant renders no level text when nothing is saved, but stays reachable", async () => {
    renderControl({ variant: "suffix" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger.textContent).toBe("");
    expect(trigger).toHaveAccessibleName("Reasoning effort: Default");
    await userEvent.click(trigger);
    expect(await effortSlider()).toBeInTheDocument();
  });

  it("inline variant reads the full level beside the icon", () => {
    renderControl({ variant: "inline", value: "high" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent(/^High$/);
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  it("inline variant reads Default when nothing is saved", () => {
    renderControl({ variant: "inline" });
    expect(screen.getByTestId("effort-control-trigger")).toHaveTextContent(
      /^Default$/,
    );
  });

  it("inline variant opens a row of level buttons, marks the saved one, and closes on a pick", async () => {
    const onChange = renderControl({
      variant: "inline",
      options: ["low", "medium", "high"],
      value: "medium",
    });
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
    ]);
    expect(screen.getByRole("radio", { name: "Medium" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("slider")).toBeNull();
    await pickEffort("High");
    expect(onChange).toHaveBeenLastCalledWith("high");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("inline variant sends undefined for Default, and nothing for the level already picked", async () => {
    const onChange = renderControl({ variant: "inline", value: "high" });
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    await userEvent.click(screen.getByRole("radio", { name: "High" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    await userEvent.click(screen.getByRole("radio", { name: "Default" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("inline variant badges a stale value with no button picked", async () => {
    renderControl({ variant: "inline", options: ["low"], value: "max" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent("Max · no longer supported");
    await userEvent.click(trigger);
    expect(
      screen
        .getAllByRole("radio")
        .some((radio) => radio.getAttribute("aria-checked") === "true"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("inline variant opens its row upward", async () => {
    renderControl({ variant: "inline", value: "high" });
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    expect(
      (await screen.findByTestId("effort-control-popover")).getAttribute(
        "data-side",
      ),
    ).toBe("top");
  });

  it("buttons variant shows the row on the page with no trigger", async () => {
    const onChange = renderControl({ variant: "buttons", value: "low" });
    expect(screen.queryByTestId("effort-control-trigger")).toBeNull();
    expect(screen.getByRole("radio", { name: "Low" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await pickEffort("High");
    expect(onChange).toHaveBeenLastCalledWith("high");
    // Still on the page after a pick: nothing to close.
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("buttons variant badges a stale value at the end of the row, and Default clears it", async () => {
    const onChange = renderControl({
      variant: "buttons",
      options: ["low"],
      value: "max",
    });
    expect(screen.getByTestId("effort-control-stale")).toHaveTextContent(
      "Max · no longer supported",
    );
    await userEvent.click(screen.getByRole("radio", { name: "Default" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("buttons variant is inert with a reason when disabled", () => {
    const onChange = renderControl({
      variant: "buttons",
      disabled: true,
      disabledReason: "Read-only.",
    });
    expect(screen.getByTestId("effort-control-disabled")).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("badges a saved effort the catalog no longer lists and lets it be cleared", async () => {
    const onChange = renderControl({ options: ["low", "high"], value: "max" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent("no longer supported");
    expect(trigger).toHaveAttribute("data-stale", "true");
    await userEvent.click(trigger);
    expect(
      await screen.findByText("Max is no longer supported by this model."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("suffix variant still badges a stale value", () => {
    renderControl({ variant: "suffix", options: ["low"], value: "max" });
    const trigger = screen.getByTestId("effort-control-trigger");
    expect(trigger).toHaveTextContent("· Max · no longer supported");
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
    expect(screen.queryByRole("slider")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    const wrapper = screen.getByTestId("effort-control-disabled");
    act(() => wrapper.focus());
    expect(
      (await screen.findAllByText("Pick a saved model first")).length,
    ).toBeGreaterThan(0);
  });
});
