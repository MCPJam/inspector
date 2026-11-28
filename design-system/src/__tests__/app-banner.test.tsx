// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AppBanner } from "../components/app-banner";

afterEach(cleanup);

describe("AppBanner", () => {
  it("announces a prominent banner as an alert with a warning rail", () => {
    render(
      <AppBanner actions={<button>Update card</button>}>Failed</AppBanner>,
    );

    const banner = screen.getByRole("alert");
    expect(banner).toHaveClass("border-l-warning", "bg-warning/10");
    expect(screen.getByRole("button", { name: "Update card" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("renders a quiet banner as a status the reader can dismiss", () => {
    const onDismiss = vi.fn();
    render(
      <AppBanner emphasis="quiet" onDismiss={onDismiss}>
        Needs attention
      </AppBanner>,
    );

    expect(screen.getByRole("status")).not.toHaveClass("bg-warning/10");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
