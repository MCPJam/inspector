import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { VariableMappingTable } from "../variable-mapping-table";

describe("VariableMappingTable", () => {
  it("shows each variable and what data it uses", () => {
    renderWithProviders(
      <VariableMappingTable
        variables={[
          { name: "tool_results", description: "Each tool step with its result" },
          { name: "final_answer", description: "The agent's final answer" },
        ]}
      />,
    );
    expect(screen.getByText("{{tool_results}}")).toBeInTheDocument();
    expect(screen.getByText("Each tool step with its result")).toBeInTheDocument();
    expect(screen.getByText("{{final_answer}}")).toBeInTheDocument();
    expect(screen.getByText("The agent's final answer")).toBeInTheDocument();
  });
});
