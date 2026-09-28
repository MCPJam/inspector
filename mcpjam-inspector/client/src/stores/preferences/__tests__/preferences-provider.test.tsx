import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PreferencesStoreProvider,
  usePreferencesStore,
  usePreferencesStoreWithDefaults,
} from "../preferences-provider";

function StrictThemeReader() {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  return <span data-testid="theme">{themeMode}</span>;
}

function TolerantThemeReader() {
  const themeMode = usePreferencesStoreWithDefaults((s) => s.themeMode);
  return <span data-testid="theme">{themeMode}</span>;
}

describe("usePreferencesStore", () => {
  it("throws without a provider so real dependencies fail loudly", () => {
    expect(() => render(<StrictThemeReader />)).toThrow(
      "Missing PreferencesStoreProvider",
    );
  });

  it("reads through the provider", () => {
    render(
      <PreferencesStoreProvider themeMode="dark" themePreset="default">
        <StrictThemeReader />
      </PreferencesStoreProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
});

describe("usePreferencesStoreWithDefaults", () => {
  it("falls back to the defaults instead of throwing without a provider", () => {
    // The point of the hook: a presentational leaf rendered bare in a unit
    // test reads "light" rather than crashing the render.
    render(<TolerantThemeReader />);
    expect(screen.getByTestId("theme").textContent).toBe("light");
  });

  it("prefers the provider's value when there is one", () => {
    render(
      <PreferencesStoreProvider themeMode="dark" themePreset="default">
        <TolerantThemeReader />
      </PreferencesStoreProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  it("does not leak a provider value into a later provider-less render", () => {
    // The fallback store is module-level and shared, so a provider render
    // must not write into it and change what the next bare render sees.
    const { unmount } = render(
      <PreferencesStoreProvider themeMode="dark" themePreset="default">
        <TolerantThemeReader />
      </PreferencesStoreProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    unmount();

    render(<TolerantThemeReader />);
    expect(screen.getByTestId("theme").textContent).toBe("light");
  });
});
