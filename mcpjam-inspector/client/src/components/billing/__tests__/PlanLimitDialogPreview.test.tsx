import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanLimitDialogPreview } from "../PlanLimitDialogPreview";

describe("PlanLimitDialogPreview", () => {
  it("records the BYOK action without leaving the preview", () => {
    const initialUrl = window.location.href;
    render(<PlanLimitDialogPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Credits", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Learn more about BYOK" }));
    expect(screen.getByText("BYOK and credits")).toBeInTheDocument();
    expect(window.location.href).toBe(initialUrl);
  });
});
