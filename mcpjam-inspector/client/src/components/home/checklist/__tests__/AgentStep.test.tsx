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

const pick = async (label: string) => {
  await userEvent.click(screen.getByRole("button", { name: /^Agent:/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: label }));
};

describe("AgentStep", () => {
  it("defaults to the plugin and shows only the picked agent's setup", async () => {
    renderStep();
    expect(screen.getByRole("link", { name: /Open the plugin/ })).toBeTruthy();
    await pick("Claude Code");
    expect(
      screen.getByText(/claude mcp add --transport http mcpjam/),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the plugin/ })).toBeNull();
    await pick("Codex");
    expect(
      screen.getByText(
        /codex mcp add mcpjam --url https:\/\/mcp\.mcpjam\.com\/mcp/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/claude mcp add/)).toBeNull();
  });

  it("groups agents in the picker", async () => {
    renderStep();
    await userEvent.click(screen.getByRole("button", { name: /^Agent:/ }));
    await screen.findByText("Install a plugin");
    const headers = screen
      .getAllByText(/^(Install a plugin|Run a command|Add to your editor)$/)
      .map((el) => el.textContent);
    expect(headers).toEqual([
      "Install a plugin",
      "Run a command",
      "Add to your editor",
    ]);
    const items = screen.getAllByRole("menuitem");
    expect(items[0].textContent).toBe("ChatGPT & Codex");
    expect(items[items.length - 1].textContent).toBe("Other");
    for (const label of [
      "Codex",
      "Cursor",
      "VS Code",
      "ChatGPT & Codex",
      "Other",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  it("offers one-click install for editors, and one plugin link", async () => {
    renderStep();
    await pick("VS Code");
    expect(
      screen.getByRole("link", { name: /Add to VS Code/ }).getAttribute("href"),
    ).toMatch(/^vscode:mcp\/install\?/);
    await pick("ChatGPT & Codex");
    const links = screen.getAllByRole("link", { name: /Open the plugin/ });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toMatch(
      /^https:\/\/chatgpt\.com\/plugins\//,
    );
  });

  it("shows only manual editor setup in the desktop app", async () => {
    vi.stubGlobal("electronAPI", {});
    try {
      renderStep();
      await pick("Cursor");
      expect(screen.queryByRole("link", { name: /Add to Cursor/ })).toBeNull();
      expect(screen.getByText("Add it by hand")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("copies the picked agent's snippet and reports which agent", async () => {
    const onCopied = vi.fn();
    renderStep(onCopied);
    await pick("Cursor");
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith("cursor"));
    expect(copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('"url": "https://mcp.mcpjam.com/mcp"'),
    );
  });

  it("shows the onboarding prompt for Other", async () => {
    renderStep();
    await pick("Other");
    expect(screen.getByText(/www\.mcpjam\.com\/prompt\.md/)).toBeTruthy();
  });
});
