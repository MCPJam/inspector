import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { VariableMappingTable } from "../variable-mapping-table";

describe("VariableMappingTable", () => {
  it("shows each variable, its source and its preview value", () => {
    renderWithProviders(
      <VariableMappingTable
        previewLabel="Iteration #3"
        paths={["transcript.toolResults", "transcript.finalAssistantMessage"]}
        variables={[
          {
            name: "tool_results",
            path: "transcript.toolResults",
            preview: '[{ "title": "AirPods Pro 2", "in_stock": false }]',
          },
          { name: "final_answer", path: "transcript.finalAssistantMessage" },
        ]}
        onPathChange={() => {}}
      />,
    );
    expect(screen.getByText("Value in Iteration #3")).toBeInTheDocument();
    expect(screen.getByText("{{tool_results}}")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Source for tool_results" }),
    ).toHaveTextContent("transcript.toolResults");
    expect(screen.getByText(/AirPods Pro 2/)).toBeInTheDocument();
    expect(screen.getByText("No preview iteration")).toBeInTheDocument();
  });
});
