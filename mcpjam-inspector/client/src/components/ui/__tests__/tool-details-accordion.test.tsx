import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolDetailsAccordion } from "../tool-details-accordion";

// CodeMirror does not lay out in jsdom; the accordion only needs to prove it
// handed the right bag to the viewer.
vi.mock("@/components/ui/json-editor", () => ({
  ScrollableJsonView: ({ value }: { value: unknown }) => (
    <div data-testid="json-view">{JSON.stringify(value)}</div>
  ),
}));

function renderAccordion(
  props: Partial<Parameters<typeof ToolDetailsAccordion>[0]> = {},
) {
  return render(
    <ToolDetailsAccordion
      description="Returns the mailbox this connection is authenticated as."
      openSections={props.openSections ?? []}
      onOpenSectionsChange={() => {}}
      {...props}
    />,
  );
}

describe("ToolDetailsAccordion annotations and metadata", () => {
  it("renders both sections when the tool declares them", () => {
    renderAccordion({
      annotations: { readOnlyHint: true, openWorldHint: false },
      metadata: { "openai/profile": true },
    });

    expect(screen.getByText("Annotations")).toBeInTheDocument();
    expect(screen.getByText("Metadata")).toBeInTheDocument();
  });

  it("shows the raw bag when a section is open", () => {
    renderAccordion({
      metadata: { "openai/profile": true },
      openSections: ["metadata"],
    });

    expect(screen.getByTestId("json-view")).toHaveTextContent(
      '{"openai/profile":true}',
    );
  });

  it("omits both sections when the tool declares neither", () => {
    renderAccordion();

    expect(screen.queryByText("Annotations")).not.toBeInTheDocument();
    expect(screen.queryByText("Metadata")).not.toBeInTheDocument();
  });

  it("omits a section whose bag is empty", () => {
    // A server that sends `_meta: {}` declares nothing; an empty row would
    // read as a declaration.
    renderAccordion({ annotations: {}, metadata: {} });

    expect(screen.queryByText("Annotations")).not.toBeInTheDocument();
    expect(screen.queryByText("Metadata")).not.toBeInTheDocument();
  });

  it("renders annotations alone for a tool with no metadata", () => {
    // The WebMCP invoke pane's shape: annotations, never `_meta`.
    renderAccordion({ annotations: { readOnly: true } });

    expect(screen.getByText("Annotations")).toBeInTheDocument();
    expect(screen.queryByText("Metadata")).not.toBeInTheDocument();
  });
});
