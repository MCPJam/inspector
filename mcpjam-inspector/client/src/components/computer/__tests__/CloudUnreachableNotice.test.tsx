/**
 * BB-63. The band is shared: the swarm sandbox block and the evals suite pin
 * both render it, and both are genuine warnings. So the alarm treatment stays
 * the DEFAULT and only the caller that asked for calm gets it — a de-escalation
 * with no blast radius.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { CloudUnreachableNotice } from "../CloudUnreachableNotice";

describe("CloudUnreachableNotice", () => {
  it("paints a warning by default, so existing callers are untouched", () => {
    render(<CloudUnreachableNotice message="Sandbox unavailable" detail="d" />);
    const root = screen.getByTestId("cloud-unreachable-notice");
    expect(root).toHaveAttribute("data-tone", "warning");
    expect(root.className).toMatch(/amber/);
    expect(screen.getByTestId("cloud-notice-alert-icon")).toBeInTheDocument();
  });

  // The actual BB-63 requirement, as an assertion: no alarm colour, no alarm
  // glyph. Asserting the class is deliberate — "less warning coded" IS a claim
  // about the colour, so a rename that quietly restores amber should fail here.
  it("drops the alarm colour and the alert glyph in guidance tone", () => {
    render(
      <CloudUnreachableNotice
        message="MCPJam has no servers attached yet."
        detail="Your project has draw. Pick what this run should use."
        tone="guidance"
      />
    );
    const root = screen.getByTestId("cloud-unreachable-notice");
    expect(root).toHaveAttribute("data-tone", "guidance");
    expect(root.className).not.toMatch(/amber/);
    expect(
      screen.queryByTestId("cloud-notice-alert-icon")
    ).not.toBeInTheDocument();
  });

  it("says the same thing in either tone", () => {
    for (const tone of ["warning", "guidance"] as const) {
      const { unmount } = render(
        <CloudUnreachableNotice message="The finding" detail="The next step" tone={tone} />
      );
      expect(screen.getByText("The finding")).toBeVisible();
      expect(screen.getByText("The next step")).toBeVisible();
      unmount();
    }
  });
});

describe("CloudUnreachableNotice action", () => {
  it("renders nothing extra when no action is given", () => {
    render(<CloudUnreachableNotice message="m" detail="d" tone="guidance" />);
    expect(
      screen.queryByTestId("cloud-notice-action")
    ).not.toBeInTheDocument();
  });

  it("renders the action and calls it", async () => {
    const onClick = vi.fn();
    render(
      <CloudUnreachableNotice
        message="Claude has no servers to run against."
        detail="These sessions run against an MCP server, so there has to be one."
        tone="guidance"
        action={{ label: "Connect a server", onClick }}
      />
    );
    const button = screen.getByRole("button", { name: "Connect a server" });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
