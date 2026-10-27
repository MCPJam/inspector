import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockListTools = vi.fn();

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

import { ConformanceProbeSettings } from "../ConformanceProbeSettings";

const TOOLS = [
  { name: "wipe-data", annotations: { destructiveHint: true } },
  { name: "emit-logs", annotations: { readOnlyHint: true } },
  { name: "ask-user", annotations: { readOnlyHint: false, destructiveHint: false } },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockListTools.mockResolvedValue({ tools: TOOLS });
});

async function openDialog(probes = {}) {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <ConformanceProbeSettings
      serverName="http-server"
      probes={probes}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Probe tools/ }));
  const logSelect = await screen.findByRole("combobox", {
    name: "Tool that emits logs",
  });
  await waitFor(() => expect(logSelect).toBeEnabled());
  return { user, onChange, logSelect };
}

describe("ConformanceProbeSettings", () => {
  it("lists the server's tools, read-only first, and saves the chosen probe with its arguments", async () => {
    const { user, onChange, logSelect } = await openDialog();
    expect(mockListTools).toHaveBeenCalledWith({ serverId: "http-server" });

    await user.click(logSelect);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "Not set",
      "emit-logs · read-only",
      "ask-user",
      "wipe-data · may modify data",
    ]);
    await user.click(screen.getByRole("option", { name: "emit-logs · read-only" }));

    fireEvent.change(
      screen.getByRole("textbox", { name: "Tool that emits logs arguments" }),
      { target: { value: '{"count": 2}' } },
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledWith({
      logProbe: { toolName: "emit-logs", arguments: { count: 2 } },
    });
  });

  it("refuses arguments that are not a JSON object and keeps the dialog open", async () => {
    const { user, onChange, logSelect } = await openDialog();
    await user.click(logSelect);
    await user.click(screen.getByRole("option", { name: "emit-logs · read-only" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Tool that emits logs arguments" }),
      { target: { value: "[1, 2]" } },
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Arguments must be a JSON object.")).toBeDefined();
  });

  it("warns when the chosen tool says it may modify data", async () => {
    const { user, logSelect } = await openDialog();
    await user.click(logSelect);
    await user.click(
      screen.getByRole("option", { name: "wipe-data · may modify data" }),
    );
    expect(screen.getByText(/This tool says it may modify data/)).toBeDefined();
  });

  it("shows how many probes are set and clears one back to Not set", async () => {
    const { user, onChange, logSelect } = await openDialog({
      logProbe: { toolName: "emit-logs" },
      inputRequiredProbe: { toolName: "ask-user" },
    });
    // `hidden`: the open modal marks the page behind it aria-hidden.
    expect(
      screen.getByRole("button", { name: "Probe tools · 2", hidden: true }),
    ).toBeDefined();

    await user.click(logSelect);
    await user.click(screen.getByRole("option", { name: "Not set" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledWith({
      inputRequiredProbe: { toolName: "ask-user" },
    });
  });

  it("keeps a saved tool the server no longer lists", async () => {
    const { user, logSelect } = await openDialog({
      logProbe: { toolName: "retired-tool" },
    });
    await user.click(logSelect);
    expect(
      screen.getByRole("option", {
        name: "retired-tool (not listed by the server)",
      }),
    ).toBeDefined();
  });
});
