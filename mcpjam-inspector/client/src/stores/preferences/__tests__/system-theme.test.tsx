import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  PreferencesStoreProvider,
  usePreferencesStore,
} from "../preferences-provider";
import {
  getInitialThemeMode,
  getInitialThemePreference,
} from "@/lib/theme-utils";

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});
it("restores System, follows device changes, and stops following after an explicit choice", () => {
  let dark = true;
  let listener: (() => void) | undefined;
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, callback: () => void) => {
      listener = callback;
    },
    removeEventListener: remove,
  }));
  localStorage.setItem("themeMode", "system");
  expect(getInitialThemePreference()).toBe("system");
  expect(getInitialThemeMode()).toBe("dark");
  function Probe() {
    const mode = usePreferencesStore((s) => s.themeMode);
    const preference = usePreferencesStore((s) => s.themePreference);
    const set = usePreferencesStore((s) => s.setThemePreference);
    return (
      <button onClick={() => set("light")}>
        {preference}:{mode}
      </button>
    );
  }
  const view = render(
    <PreferencesStoreProvider themeMode="dark" themePreset="default">
      <Probe />
    </PreferencesStoreProvider>,
  );
  expect(screen.getByRole("button")).toHaveTextContent("system:dark");
  expect(document.documentElement).toHaveClass("dark");
  act(() => {
    dark = false;
    listener?.();
  });
  expect(screen.getByRole("button")).toHaveTextContent("system:light");
  expect(localStorage.getItem("themeMode")).toBe("system");
  fireEvent.click(screen.getByRole("button"));
  act(() => {
    dark = true;
    listener?.();
  });
  expect(screen.getByRole("button")).toHaveTextContent("light:light");
  expect(document.documentElement).not.toHaveClass("dark");
  expect(localStorage.getItem("themeMode")).toBe("light");
  view.unmount();
  expect(remove).toHaveBeenCalledWith("change", listener);
});
