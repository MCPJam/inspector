import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  posthog: null as { register: (props: object) => void } | null,
}));

vi.mock("posthog-js/react", () => ({ usePostHog: () => state.posthog }));

import { usePostHogThemeContext } from "../usePostHogThemeContext";

type Props = Parameters<typeof usePostHogThemeContext>;

describe("usePostHogThemeContext", () => {
  const register = vi.fn();

  beforeEach(() => {
    register.mockClear();
    state.posthog = { register };
  });

  it("registers the resolved mode and the Settings preference", () => {
    renderHook(() => usePostHogThemeContext("dark", "system"));

    expect(register).toHaveBeenCalledWith({
      theme_mode: "dark",
      theme_preference: "system",
    });
  });

  it("re-registers when the theme changes", () => {
    const { rerender } = renderHook(
      ([mode, preference]: Props) => usePostHogThemeContext(mode, preference),
      { initialProps: ["light", "light"] as Props },
    );

    rerender(["dark", "dark"]);

    expect(register).toHaveBeenLastCalledWith({
      theme_mode: "dark",
      theme_preference: "dark",
    });
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("does nothing before PostHog is ready", () => {
    state.posthog = null;

    expect(() =>
      renderHook(() => usePostHogThemeContext("dark", "dark")),
    ).not.toThrow();
  });
});
