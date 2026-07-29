import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwarmsEmptyHero } from "../swarms-empty-hero";

describe("SwarmsEmptyHero", () => {
  it("renders the evals-style empty hero and wires the create CTA", () => {
    const onCreatePersona = vi.fn();
    render(<SwarmsEmptyHero onCreatePersona={onCreatePersona} />);

    expect(screen.getByTestId("swarms-empty-hero")).toBeTruthy();
    expect(screen.getByText("Create your first persona")).toBeTruthy();
    expect(screen.getByText("What swarms looks like")).toBeTruthy();
    expect(screen.getByText("Journey trend")).toBeTruthy();
    expect(screen.getByText("Client matrix")).toBeTruthy();
    expect(screen.getByText("Session trace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /create persona/i }));
    expect(onCreatePersona).toHaveBeenCalledTimes(1);
  });
});
