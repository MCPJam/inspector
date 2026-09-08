/**
 * The percent field behind the v2 policy and validity controls.
 *
 * Three ways a field that LOOKS idle can rewrite a suite:
 *
 *   - a blank Pass threshold committing 0, which turns an empty box into an
 *     accept-anything policy;
 *   - Escape committing the typed value, because `blur()` runs the commit
 *     against the text still on screen;
 *   - focus + blur on a stored 0.855, which the field shows as "86", saving
 *     0.86 for a reader who typed nothing.
 *
 * The validity fields share the component and keep the OTHER meaning of a
 * blank: leave it empty to select the contract default.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  VerdictPolicyV2Controls,
  VerdictValidityControls,
} from "../suite-policy-controls";

const THRESHOLD = /fraction of a case's trials that must pass/i;

function renderThreshold(passThreshold: number) {
  const onChange = vi.fn();
  render(
    <VerdictPolicyV2Controls
      defaults={{ repetitions: 3, passThreshold }}
      onChange={onChange}
    />,
  );
  return {
    onChange,
    input: screen.getByLabelText(THRESHOLD) as HTMLInputElement,
  };
}

describe("VerdictPolicyV2Controls pass threshold", () => {
  it("reverts a blank to the stored value instead of committing 0", async () => {
    const user = userEvent.setup();
    const { onChange, input } = renderThreshold(0.8);
    await user.clear(input);
    await user.tab();
    // A blank is not a bar of zero. Nothing was drafted, and the field shows
    // what the suite still holds.
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("80");
  });

  it("reverts on Escape without committing the typed value", async () => {
    const user = userEvent.setup();
    const { onChange, input } = renderThreshold(0.8);
    await user.clear(input);
    await user.type(input, "55");
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("80");
    expect(document.activeElement).not.toBe(input);
  });

  it("does not commit a rounded display value on a no-edit blur", async () => {
    const user = userEvent.setup();
    const { onChange, input } = renderThreshold(0.855);
    expect(input.value).toBe("86");
    await user.click(input);
    await user.tab();
    // The field could only show 86, but the suite holds 0.855, and a reader
    // who edited nothing must not have moved it to 0.86.
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("86");
  });

  it("still commits a value that actually changed", async () => {
    const user = userEvent.setup();
    const { onChange, input } = renderThreshold(0.855);
    await user.clear(input);
    await user.type(input, "90");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith({
      repetitions: 3,
      passThreshold: 0.9,
    });
  });
});

describe("VerdictValidityControls", () => {
  it("keeps a blank meaning unset on the optional fields", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VerdictValidityControls
        defaults={{
          repetitions: 1,
          passThreshold: 1,
          validity: { minCompletionRate: 0.8 },
        }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(
      /minimum share of trials that must have completed/i,
    );
    await user.clear(input);
    await user.tab();
    // Empty selects the contract default, so the ceiling is dropped rather
    // than reverted — the opposite of what the required threshold does.
    expect(onChange).toHaveBeenCalledWith({
      repetitions: 1,
      passThreshold: 1,
      validity: undefined,
    });
  });
});
