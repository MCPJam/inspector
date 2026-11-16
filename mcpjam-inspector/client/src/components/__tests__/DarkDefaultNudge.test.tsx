import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  custom: vi.fn(),
  dismiss: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { custom: mocks.custom, dismiss: mocks.dismiss },
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mocks.navigate,
}));

import {
  DARK_DEFAULT_NUDGE_KEY,
  DarkDefaultNudge,
} from "../DarkDefaultNudge";
import {
  getInitialThemeMode,
  getInitialThemePreference,
} from "@/lib/theme-utils";

function renderShownCard() {
  const renderCard = mocks.custom.mock.calls[0][0] as (
    id: string,
  ) => ReactNode;
  render(<>{renderCard("toast-1")}</>);
}

beforeEach(() => {
  localStorage.clear();
  mocks.custom.mockClear();
  mocks.dismiss.mockClear();
  mocks.navigate.mockClear();
});

describe("dark default", () => {
  it("uses dark when no theme was picked", () => {
    expect(getInitialThemePreference()).toBe("dark");
    expect(getInitialThemeMode()).toBe("dark");
  });

  it("keeps a theme the user picked", () => {
    localStorage.setItem("themeMode", "light");
    expect(getInitialThemeMode()).toBe("light");
  });
});

describe("DarkDefaultNudge", () => {
  it("defers without marking seen until announcements are enabled", () => {
    const { rerender } = render(<DarkDefaultNudge enabled={false} />);
    expect(mocks.custom).not.toHaveBeenCalled();
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBeNull();

    rerender(<DarkDefaultNudge enabled />);
    expect(mocks.custom).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBe("1");
  });

  it("dismisses an existing toast when announcements become disabled", () => {
    const { rerender } = render(<DarkDefaultNudge />);
    expect(mocks.custom).toHaveBeenCalledTimes(1);

    rerender(<DarkDefaultNudge enabled={false} />);
    expect(mocks.dismiss).toHaveBeenCalledWith("dark-default-nudge");
  });

  it("shows once to someone who never picked a theme", () => {
    const { unmount } = render(<DarkDefaultNudge />);
    expect(mocks.custom).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBe("1");

    unmount();
    render(<DarkDefaultNudge />);
    expect(mocks.custom).toHaveBeenCalledTimes(1);
  });

  it("explains the change in the card", () => {
    render(<DarkDefaultNudge />);
    renderShownCard();
    expect(
      screen.getByText("Dark mode is now the default."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You can switch to light or System in Settings."),
    ).toBeInTheDocument();
  });

  it("closes without navigating on Keep dark", () => {
    render(<DarkDefaultNudge />);
    renderShownCard();
    fireEvent.click(screen.getByRole("button", { name: "Keep dark" }));
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-1");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("opens Appearance settings and closes", () => {
    render(<DarkDefaultNudge />);
    renderShownCard();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(mocks.navigate).toHaveBeenCalledWith("/settings/appearance");
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("stays quiet when the seen marker cannot be saved", () => {
    // The test setup resets this override after each test.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<DarkDefaultNudge />);
      expect(mocks.custom).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet for someone who already picked a theme", () => {
    localStorage.setItem("themeMode", "light");
    render(<DarkDefaultNudge />);
    expect(mocks.custom).not.toHaveBeenCalled();
  });
});
