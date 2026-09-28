import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describeAsSlug } from "@mcpjam/sdk/browser";
import { ErrorCard } from "../error-card";

/**
 * A primary action is the fix. The collapsed face then keeps that click and
 * a clickable title; the diagnostic rows wait behind it. These pin that density
 * so a later revert cannot quietly restore the full status report next to
 * Reconnect.
 */
describe("ErrorCard compact action face", () => {
  const consent = () =>
    describeAsSlug("auth/consent_required", new Error("x"));

  it("keeps the action and a clickable title, and hides the diagnostic rows", () => {
    const onClick = vi.fn();
    render(
      <ErrorCard
        error={consent()}
        action={{ label: "Reconnect", onClick }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("error-card-details")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Show details")).not.toBeInTheDocument();
    expect(
      screen.queryByText("This server needs your permission before it can connect."),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("error-card-origin-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("error-card-copy")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    const row = screen.getByRole("alert");
    expect(row).toHaveAttribute("data-compact");
    expect(row.className).not.toMatch(/\bp-3\b/);
    expect(row.querySelector(".h-6\\.5")).not.toBeNull();
  });

  it("opens the diagnostic rows from the title", () => {
    render(
      <ErrorCard
        error={consent()}
        action={{ label: "Reconnect", onClick: vi.fn() }}
      />,
    );

    fireEvent.click(screen.getByTestId("error-card-details"));

    expect(
      screen.getByText(
        "This server needs your permission before it can connect.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("error-card-origin-badge"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Why this happened")).toBeInTheDocument();
    expect(screen.getByTestId("error-card-copy")).toBeInTheDocument();
    expect(screen.getByTestId("error-card-details")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("carries the MCPJam badge into the panel it opens", () => {
    render(
      <ErrorCard
        error={describeAsSlug(
          "sdk/not_yet_supported_in_stateless",
          new Error("x"),
        )}
        action={{ label: "Reconnect", onClick: vi.fn() }}
      />,
    );

    fireEvent.click(screen.getByTestId("error-card-details"));

    expect(screen.getByTestId("error-card-origin-badge")).toHaveTextContent(
      "MCPJam issue",
    );
  });

  it("does not compact a card that has no action to keep", () => {
    render(<ErrorCard error={consent()} />);

    expect(
      screen.getByText(
        "This server needs your permission before it can connect.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Show details")).toBeInTheDocument();
    expect(screen.getByTestId("error-card-copy")).toBeInTheDocument();
  });

  it("compacts a diagnostic card when the caller asks for row density", () => {
    render(
      <ErrorCard
        error={describeAsSlug("internal/unknown", new Error("STDIO blocked"))}
        density="row"
      />,
    );

    expect(screen.getByRole("alert")).toHaveAttribute("data-compact");
    expect(screen.queryByText("STDIO blocked")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("error-card-details"));
    expect(screen.getByText("STDIO blocked")).toBeInTheDocument();
  });
});
