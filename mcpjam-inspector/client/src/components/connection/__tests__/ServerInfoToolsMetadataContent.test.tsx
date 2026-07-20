import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import { ServerInfoToolsMetadataContent } from "../ServerInfoToolsMetadataContent";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

function makeToolsData(
  tools: Tool[],
  toolsMetadata?: Record<string, Record<string, unknown>>,
): ListToolsResultWithMetadata {
  return { tools, ...(toolsMetadata ? { toolsMetadata } : {}) } as unknown as ListToolsResultWithMetadata;
}

describe("ServerInfoToolsMetadataContent", () => {
  it("lists tools even when none carry metadata (#125K4kNJ)", () => {
    // Regression: the "Tools" tab used to short-circuit to "No tool metadata
    // available" whenever no tool had `_meta`, hiding the entire tool list for
    // the common case of a server whose tools ship without metadata.
    const toolsData = makeToolsData([
      { name: "search", description: "Search the index" } as Tool,
      { name: "fetch", description: "Fetch a document" } as Tool,
    ]);

    render(<ServerInfoToolsMetadataContent toolsData={toolsData} />);

    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("Search the index")).toBeInTheDocument();
    expect(screen.getByText("fetch")).toBeInTheDocument();
    expect(
      screen.queryByText(/no tool metadata available/i),
    ).not.toBeInTheDocument();
  });

  it("shows the READ/WRITE badge and metadata when a tool has it", () => {
    const toolsData = makeToolsData(
      [{ name: "delete_file", description: "Deletes a file" } as Tool],
      { delete_file: { write: true, category: "fs" } },
    );

    render(<ServerInfoToolsMetadataContent toolsData={toolsData} />);

    expect(screen.getByText("delete_file")).toBeInTheDocument();
    expect(screen.getByText("WRITE")).toBeInTheDocument();
    expect(screen.getByText("METADATA")).toBeInTheDocument();
  });

  it("shows an empty state only when there are genuinely no tools", () => {
    render(<ServerInfoToolsMetadataContent toolsData={makeToolsData([])} />);

    expect(screen.getByText(/no tools available/i)).toBeInTheDocument();
  });

  it("falls back to a placeholder description when a tool has none", () => {
    const toolsData = makeToolsData([{ name: "ping" } as Tool]);

    render(<ServerInfoToolsMetadataContent toolsData={toolsData} />);

    expect(screen.getByText("ping")).toBeInTheDocument();
    expect(screen.getByText("No description available")).toBeInTheDocument();
  });
});
