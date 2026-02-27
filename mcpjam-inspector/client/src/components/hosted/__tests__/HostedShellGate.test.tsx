import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HostedShellGate } from "../HostedShellGate";

describe("HostedShellGate", () => {
  it("renders children unchanged when state is ready", () => {
    render(
      <HostedShellGate state="ready">
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(screen.getByText("App Content")).toBeInTheDocument();
    expect(screen.queryByTestId("hosted-shell-gate-overlay")).toBeNull();
    expect(screen.getByTestId("hosted-shell-gate-content")).not.toHaveAttribute(
      "inert",
    );
  });

  it("passes through children unblocked during auth-loading", () => {
    render(
      <HostedShellGate state="auth-loading">
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(screen.getByText("App Content")).toBeInTheDocument();
    expect(screen.queryByTestId("hosted-shell-gate-overlay")).toBeNull();
    expect(screen.getByTestId("hosted-shell-gate-content")).not.toHaveAttribute(
      "inert",
    );
  });

  it("shows workspace loading copy", () => {
    render(
      <HostedShellGate state="workspace-loading">
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(screen.getByText("Preparing workspace...")).toBeInTheDocument();
  });

  it("shows sign in call-to-action when logged out", () => {
    const onSignIn = vi.fn();

    render(
      <HostedShellGate state="logged-out" onSignIn={onSignIn}>
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(
      screen.getByText("Sign in to MCPJam to continue"),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "MCPJam" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
