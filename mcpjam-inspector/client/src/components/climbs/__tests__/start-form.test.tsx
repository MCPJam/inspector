import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const startClimb = vi.fn();
vi.mock("@/lib/apis/climbs-api", () => ({
  startClimb: (...args: unknown[]) => startClimb(...args),
}));

import { StartForm } from "../start-form";

const baseProps = {
  projectId: "proj_1",
  suite: { id: "suite_1", name: "mcpjam-mcp dogfood" },
  caseCount: 10,
  servers: [
    { id: "srv_1", name: "mcpjam-mcp" },
    { id: "srv_2", name: "stateless" },
  ],
  environments: [
    { id: "env_a", label: "MCPJam · Sonnet 5.5" },
    { id: "env_b", label: "Claude Code · Sonnet 5.5" },
  ],
  models: [{ id: "m1", name: "Sonnet 5.5" }],
  onStarted: vi.fn(),
};

beforeEach(() => {
  startClimb.mockReset();
  baseProps.onStarted.mockReset();
});

describe("StartForm", () => {
  it("shows the suite, where it runs, who picks and the limits", () => {
    render(<StartForm {...baseProps} />);
    expect(screen.getByRole("heading", { name: "Start a climb" })).toBeInTheDocument();
    expect(screen.getByText(/From the suite mcpjam-mcp dogfood, 10 cases/)).toBeInTheDocument();
    expect(screen.getByLabelText("MCPJam · Sonnet 5.5")).toBeChecked();
    expect(screen.getByLabelText("Claude Code · Sonnet 5.5")).toBeChecked();
    expect(screen.getByRole("radio", { name: "You" })).toBeChecked();
    expect(screen.getByText("Nothing runs until you say so.")).toBeInTheDocument();
    expect(screen.getByLabelText("Credits")).toHaveValue("4,000");
    // Ten cases are too few to set any aside.
    expect(screen.getByText(/too few cases to set any aside/)).toBeInTheDocument();
  });

  it("starts on the suite's own server, not the project's first", async () => {
    startClimb.mockResolvedValue({ climbId: "climb_1" });
    render(<StartForm {...baseProps} suite={{ ...baseProps.suite, servers: ["stateless"] }} />);
    await userEvent.click(screen.getByRole("button", { name: /Run the baseline/ }));
    await waitFor(() => expect(startClimb).toHaveBeenCalled());
    expect(startClimb).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv_2" }));
  });

  it("starts the baseline with the person as picker", async () => {
    startClimb.mockResolvedValue({ climbId: "climb_1" });
    render(<StartForm {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Run the baseline/ }));
    await waitFor(() => expect(baseProps.onStarted).toHaveBeenCalledWith({ climbId: "climb_1" }));
    expect(startClimb).toHaveBeenCalledWith({
      projectId: "proj_1",
      suiteId: "suite_1",
      serverId: "srv_1",
      roundLimit: 10,
      creditLimit: 4000,
      picker: "person",
    });
  });

  it("sends the model when MCPJam picks", async () => {
    startClimb.mockResolvedValue({ climbId: "climb_2" });
    render(<StartForm {...baseProps} />);
    await userEvent.click(screen.getByRole("radio", { name: "MCPJam" }));
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByText(/You can close this page/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Run the baseline/ }));
    await waitFor(() => expect(startClimb).toHaveBeenCalled());
    expect(startClimb.mock.calls[0][0]).toMatchObject({ picker: "mcpjam", pickerModel: "m1" });
  });

  it("offers a prompt instead of starting when the person's own agent runs the climb", async () => {
    render(<StartForm {...baseProps} />);
    await userEvent.click(screen.getByRole("radio", { name: "Your own agent" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy the prompt for your agent" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      'climb mcpjam-mcp on the suite "mcpjam-mcp dogfood"',
    );
    expect(startClimb).not.toHaveBeenCalled();
  });

  it("says what to fix and starts nothing when the limits are not numbers", async () => {
    render(<StartForm {...baseProps} />);
    await userEvent.clear(screen.getByLabelText("Credits"));
    await userEvent.type(screen.getByLabelText("Credits"), "many");
    await userEvent.click(screen.getByRole("button", { name: /Run the baseline/ }));
    expect(await screen.findByText("Enter a credit limit of 1 or more.")).toBeInTheDocument();
    expect(startClimb).not.toHaveBeenCalled();
  });

  it("keeps the form and shows the refusal when the backend refuses", async () => {
    startClimb.mockRejectedValue(new Error("This suite has no cases that can steer. Add cases, then start again."));
    render(<StartForm {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Run the baseline/ }));
    expect(await screen.findByText(/no cases that can steer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run the baseline/ })).toBeEnabled();
  });

  it("disables MCPJam when no model is available", () => {
    render(<StartForm {...baseProps} models={[]} />);
    expect(screen.getByRole("radio", { name: "MCPJam" })).toBeDisabled();
    expect(screen.getByText(/needs a model to pick with/)).toBeInTheDocument();
  });
});
