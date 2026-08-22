import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LoadingScreen from "../LoadingScreen";

describe("LoadingScreen", () => {
  it("always renders the MCPJam branding mark", () => {
    render(<LoadingScreen />);

    const logo = screen.getByRole("img", { name: /MCPJam/i });
    expect(logo).toBeInTheDocument();
    // Theme-agnostic icon mark — no light/dark variant to refetch mid-flow.
    expect(logo).toHaveAttribute("src", "/mcp_jam.svg");
  });

  it("exposes a polite status live region for assistive tech", () => {
    render(<LoadingScreen />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
  });

  it("shows an sr-only 'Loading' fallback when no message is provided", () => {
    render(<LoadingScreen />);

    const fallback = screen.getByText("Loading");
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveClass("sr-only");
  });

  it("renders a provided message and drops the sr-only fallback", () => {
    render(<LoadingScreen message="Setting things up..." />);

    expect(screen.getByText("Setting things up...")).toBeInTheDocument();
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
  });

  it("treats an empty message as no message (keeps the fallback)", () => {
    render(<LoadingScreen message="" />);

    // Empty string is falsy, so the accessible fallback still applies.
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("treats a null message like no message (defensive against untyped JS callers)", () => {
    // `message` is typed string | undefined, but a plain-JS caller could still
    // pass null at runtime; it must fall back to the accessible "Loading" label.
    render(<LoadingScreen message={null as unknown as string} />);

    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("marks the decorative spinner as hidden from assistive tech", () => {
    const { container } = render(<LoadingScreen message="Working" />);

    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute("aria-hidden", "true");
  });
});
