import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({}) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { OccupationGate } from "../OccupationGate";

const continueButton = () => screen.getByRole("button", { name: "Continue" });

describe("OccupationGate", () => {
  it("keeps the form disabled and Continue spinning while busy", () => {
    render(<OccupationGate email="jo@acme.com" busy />);
    expect(screen.getByRole("textbox", { name: "Role" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Software Engineer" }),
    ).toBeDisabled();
    expect(continueButton()).toBeDisabled();
    expect(continueButton().querySelector(".animate-spin")).not.toBeNull();
    expect(continueButton().closest("form")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("works as before without it", () => {
    render(<OccupationGate email="jo@acme.com" />);
    const role = screen.getByRole("textbox", { name: "Role" });
    expect(role).toBeEnabled();
    expect(continueButton()).toBeDisabled();
    fireEvent.change(role, { target: { value: "Platform Engineer" } });
    expect(continueButton()).toBeEnabled();
    expect(continueButton().querySelector(".animate-spin")).toBeNull();
  });
});
