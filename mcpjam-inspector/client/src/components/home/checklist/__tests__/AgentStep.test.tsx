import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentStep } from "../AgentStep";

const copyToClipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard }));

const renderStep = (onCopied = vi.fn()) =>
  render(
    <AgentStep
      done={false}
      onCopied={onCopied}
      onConfirm={vi.fn()}
      onSkip={vi.fn()}
    />,
  );

describe("AgentStep", () => {
  it("shows the hosted MCP setup for each coding agent", async () => {
    renderStep();
    expect(
      screen.getByText(/claude mcp add --transport http mcpjam/),
    ).toBeTruthy();
    for (const label of ["Codex", "Cursor", "VS Code", "Other"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(
      screen.getByText(
        /codex mcp add mcpjam --url https:\/\/mcp\.mcpjam\.com\/mcp/,
      ),
    ).toBeTruthy();
  });

  it("copies the selected agent's snippet and reports which agent", async () => {
    const onCopied = vi.fn();
    renderStep(onCopied);
    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith("cursor"));
    expect(copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('"url": "https://mcp.mcpjam.com/mcp"'),
    );
  });
});
