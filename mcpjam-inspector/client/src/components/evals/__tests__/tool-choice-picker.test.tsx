import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { ToolChoicePicker } from "../tool-choice-picker";

describe("ToolChoicePicker", () => {
  it("lists modes and shows tool params when a tool is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <ToolChoicePicker
        value={undefined}
        onChange={onChange}
        availableTools={[
          {
            name: "search_docs",
            description: "Searches the docs index.",
            serverId: "docs",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The search query.",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of results to return.",
                },
              },
              required: ["query"],
            },
          },
          {
            name: "get_user",
            description: "Loads a specific user.",
            inputSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
              },
              required: ["id"],
            },
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Tool choice" }));

    expect(screen.getAllByText("Automatic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No tools").length).toBeGreaterThan(0);
    expect(screen.getByText("search_docs")).toBeTruthy();
    expect(screen.getByText("get_user")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /search_docs/i }));

    expect(onChange).toHaveBeenCalledWith({
      type: "tool",
      toolName: "search_docs",
    });
    expect(screen.getByText("Params")).toBeTruthy();
    expect(screen.getByText("query")).toBeTruthy();
    expect(screen.getByText("limit")).toBeTruthy();
    expect(screen.getByText("required")).toBeTruthy();
    expect(screen.getByText("Full Schema")).toBeTruthy();
  });
});
