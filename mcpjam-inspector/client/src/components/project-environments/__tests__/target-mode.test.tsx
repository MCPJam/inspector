/**
 * Shared target-mode selection: default latching (settle-once, no mid-form
 * flip) and the toggle's WAI-ARIA keyboard contract.
 */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TargetModeToggle, useTargetMode } from "../target-mode";

describe("useTargetMode", () => {
  it("defaults to clients while the environment list is loading, then latches env mode on settle", () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number | undefined }) =>
        useTargetMode({ environmentsEnabled: true, environmentCount: count }),
      { initialProps: { count: undefined as number | undefined } }
    );
    expect(result.current.targetMode).toBe("clients");

    rerender({ count: 2 });
    expect(result.current.targetMode).toBe("environments");
  });

  it("does NOT flip a latched clients default when the first environment appears mid-form", () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number | undefined }) =>
        useTargetMode({ environmentsEnabled: true, environmentCount: count }),
      { initialProps: { count: 0 as number | undefined } }
    );
    expect(result.current.targetMode).toBe("clients");

    // A teammate creates the project's first environment while the user is
    // mid-form: the latched default must hold.
    rerender({ count: 1 });
    expect(result.current.targetMode).toBe("clients");

    // Reset (form close) re-derives from the CURRENT count.
    act(() => result.current.resetTargetMode());
    rerender({ count: 1 });
    expect(result.current.targetMode).toBe("environments");
  });

  it("user override wins and reset returns to the derived default", () => {
    const { result } = renderHook(() =>
      useTargetMode({ environmentsEnabled: true, environmentCount: 3 })
    );
    expect(result.current.targetMode).toBe("environments");
    act(() => result.current.setTargetMode("clients"));
    expect(result.current.targetMode).toBe("clients");
    act(() => result.current.resetTargetMode());
    expect(result.current.targetMode).toBe("environments");
  });

  it("flag off forces clients regardless of environments", () => {
    const { result } = renderHook(() =>
      useTargetMode({ environmentsEnabled: false, environmentCount: 5 })
    );
    expect(result.current.targetMode).toBe("clients");
  });
});

describe("TargetModeToggle", () => {
  it("roving tabIndex: only the checked pill is tabbable; arrows select the other option", () => {
    const onChange = vi.fn();
    render(
      <TargetModeToggle
        value="environments"
        onChange={onChange}
        testIdPrefix="t"
        ariaLabel="Target mode"
      />
    );
    const env = screen.getByTestId("t-target-mode-environments");
    const clients = screen.getByTestId("t-target-mode-clients");
    expect(env).toHaveAttribute("tabindex", "0");
    expect(clients).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(env, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("clients");
  });
});
