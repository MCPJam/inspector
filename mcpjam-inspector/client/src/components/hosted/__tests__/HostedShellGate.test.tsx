import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("shows project loading copy", () => {
    render(
      <HostedShellGate state="project-loading">
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(screen.getByText("Preparing project...")).toBeInTheDocument();
  });

  it("shows custom project loading copy", () => {
    render(
      <HostedShellGate
        state="project-loading"
        loadingMessage="Finishing OAuth sign-in for demo-server..."
      >
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(
      screen.getByText("Finishing OAuth sign-in for demo-server..."),
    ).toBeInTheDocument();
  });

  it("blocks input while the project-loading overlay is up", () => {
    render(
      <HostedShellGate state="project-loading">
        <div>App Content</div>
      </HostedShellGate>,
    );

    expect(screen.getByTestId("hosted-shell-gate-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("hosted-shell-gate-content")).toHaveAttribute(
      "inert",
    );
  });
});
