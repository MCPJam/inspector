/**
 * Drive the reasoning-effort control (`EffortControl`) from a test: open the
 * popover first, then `await pickEffort("High")` walks the slider with the
 * arrow keys until its value reads `name` ("Default", "Low", "X-High", ...).
 * Every step commits, like a keyboard user, so assert on the LAST change.
 * The `inline` variant has a row of level buttons instead; there it clicks
 * the one named `name`.
 */
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export async function effortSlider(): Promise<HTMLElement> {
  return screen.findByRole("slider", { name: "Reasoning effort" });
}

export async function pickEffort(name: string): Promise<void> {
  const group = screen.queryByRole("radiogroup", { name: "Reasoning effort" });
  if (group) {
    await userEvent.click(screen.getByRole("radio", { name }));
    return;
  }
  const slider = await effortSlider();
  act(() => slider.focus());
  const reads = () => slider.getAttribute("aria-valuetext");
  const max = Number(slider.getAttribute("aria-valuemax"));
  for (let step = 0; step <= max && reads() !== name; step++) {
    if (Number(slider.getAttribute("aria-valuenow")) >= max) break;
    await userEvent.keyboard("{ArrowRight}");
  }
  for (let step = 0; step <= max && reads() !== name; step++) {
    await userEvent.keyboard("{ArrowLeft}");
  }
  if (reads() !== name) {
    throw new Error(`Effort slider has no "${name}" stop (reads ${reads()})`);
  }
}
