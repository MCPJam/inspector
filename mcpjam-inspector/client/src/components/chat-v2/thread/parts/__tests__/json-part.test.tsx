import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { JsonPart } from "../json-part";

const mockJsonEditor = vi.fn(({ value, height, maxHeight }: any) => (
  <div
    data-testid="json-editor"
    data-height={String(height)}
    data-max-height={String(maxHeight)}
  >
    {JSON.stringify(value)}
  </div>
));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

describe("JsonPart", () => {
  it("renders a content-sized JsonEditor with a capped height", () => {
    render(<JsonPart label="Result" value={{ ok: true }} />);

    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-height",
      "84",
    );
    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-max-height",
      "480",
    );
  });

  it("caps large JSON payloads at the chat max height", () => {
    render(
      <JsonPart
        label="Result"
        value={{
          users: Array.from({ length: 50 }, (_, index) => ({
            id: index,
            avatarUrl: `https://example.com/${"a".repeat(120)}/${index}`,
          })),
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-height",
      "480",
    );
  });

  it("allows app-builder style json parts to auto-size", () => {
    render(<JsonPart label="Result" value={{ ok: true }} autoHeight />);

    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-height",
      "auto",
    );
    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-max-height",
      "undefined",
    );
  });
});
