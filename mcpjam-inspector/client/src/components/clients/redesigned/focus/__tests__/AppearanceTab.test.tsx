import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import { AppearanceTab } from "../AppearanceTab";

/**
 * Local controlled wrapper so tests can observe the draft after each
 * onDraftChange. Mirrors how `HostFocusPanel` threads the prop in real use.
 */
function ControlledAppearanceTab({
  initial,
  onChange,
}: {
  initial: HostConfigInputV2;
  onChange?: (next: HostConfigInputV2) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <AppearanceTab
      draft={draft}
      onDraftChange={(updater) =>
        setDraft((prev) => {
          const next = updater(prev);
          onChange?.(next);
          return next;
        })
      }
    />
  );
}

describe("AppearanceTab", () => {
  it("renders dots controls by default and hides the reset button when no override is set", () => {
    render(<ControlledAppearanceTab initial={emptyHostConfigInputV2()} />);
    // Reset button is hidden when chatUiOverride is undefined.
    expect(
      screen.queryByRole("button", { name: /reset to preset/i }),
    ).toBeNull();
    // Dots is the default indicator kind.
    expect(
      screen.getByRole("group", { name: /indicator kind/i }),
    ).toBeInTheDocument();
    // Color + count controls are present (the dots branch).
    expect(screen.getByLabelText(/dot color/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /dot count/i })).toBeInTheDocument();
  });

  it("editing the logo URL stores it on chatUiOverride.logoSrc", () => {
    let captured: HostConfigInputV2 | null = null;
    render(
      <ControlledAppearanceTab
        initial={emptyHostConfigInputV2()}
        onChange={(next) => (captured = next)}
      />,
    );
    const input = screen.getByPlaceholderText(/example\.com\/logo/i);
    fireEvent.change(input, { target: { value: "/openai_logo.png" } });
    expect(captured!.chatUiOverride).toEqual({ logoSrc: "/openai_logo.png" });
  });

  it("clearing the logo input drops the field and unsets chatUiOverride", () => {
    let captured: HostConfigInputV2 | null = null;
    render(
      <ControlledAppearanceTab
        initial={emptyHostConfigInputV2({
          chatUiOverride: { logoSrc: "/x.png" },
        })}
        onChange={(next) => (captured = next)}
      />,
    );
    const input = screen.getByPlaceholderText(/example\.com\/logo/i);
    fireEvent.change(input, { target: { value: "" } });
    expect(captured!.chatUiOverride).toBeUndefined();
  });

  it("switches to the image branch and exposes its conditional fields", () => {
    let captured: HostConfigInputV2 | null = null;
    render(
      <ControlledAppearanceTab
        initial={emptyHostConfigInputV2()}
        onChange={(next) => (captured = next)}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /image/i }));
    expect(captured!.chatUiOverride?.indicator).toEqual({
      kind: "image",
      src: "",
      animation: "pulse",
    });
    // Image-branch fields appear; dots-branch fields are gone.
    expect(
      screen.getByPlaceholderText(/example\.com\/spinner/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/dot color/i)).toBeNull();
  });

  it("editing the dot color persists the kind:'dots' indicator with the new color", () => {
    let captured: HostConfigInputV2 | null = null;
    render(
      <ControlledAppearanceTab
        initial={emptyHostConfigInputV2()}
        onChange={(next) => (captured = next)}
      />,
    );
    const colorInput = screen.getByLabelText(/dot color/i);
    fireEvent.change(colorInput, { target: { value: "#3b82f6" } });
    expect(captured!.chatUiOverride?.indicator).toEqual({
      kind: "dots",
      color: "#3b82f6",
      count: 3,
    });
  });

  it("Reset to preset clears the entire chatUiOverride", () => {
    let captured: HostConfigInputV2 | null = null;
    render(
      <ControlledAppearanceTab
        initial={emptyHostConfigInputV2({
          chatUiOverride: {
            logoSrc: "/x.png",
            indicator: { kind: "dots", color: "#000", count: 2 },
          },
        })}
        onChange={(next) => (captured = next)}
      />,
    );
    const reset = screen.getByRole("button", { name: /reset to preset/i });
    fireEvent.click(reset);
    expect(captured!.chatUiOverride).toBeUndefined();
  });

  it("preview renders the preset's bespoke indicator when no override is set", () => {
    // Empty draft → resolves to the default host (MCPJam) → preset
    // indicator (MCPJamMarkIndicator) renders, NOT the dispatcher's
    // 3-dot fallback. This is what the chat surface actually shows.
    render(<ControlledAppearanceTab initial={emptyHostConfigInputV2()} />);
    const preview = screen.getByTestId("appearance-indicator-preview");
    // Preset wins → no dispatcher node should appear.
    expect(
      preview.querySelector('[data-testid="loading-indicator-dispatch-dots"]'),
    ).toBeNull();
    expect(
      preview.querySelector('[data-testid="loading-indicator-dispatch-image"]'),
    ).toBeNull();
    // Some indicator was rendered (preset bespoke component).
    expect(preview.firstElementChild).not.toBeNull();
  });

  it("preview switches to the dispatcher when an indicator override is set", () => {
    render(
      <ControlledAppearanceTab
        initial={emptyHostConfigInputV2({
          chatUiOverride: { indicator: { kind: "dots", color: "#3b82f6", count: 2 } },
        })}
      />,
    );
    const preview = screen.getByTestId("appearance-indicator-preview");
    const dots = preview.querySelector(
      '[data-testid="loading-indicator-dispatch-dots"]',
    );
    expect(dots).not.toBeNull();
    expect(dots!.getAttribute("data-dot-count")).toBe("2");
  });
});
