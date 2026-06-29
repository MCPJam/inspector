import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      "84"
    );
    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-max-height",
      "480"
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
      />
    );

    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-height",
      "480"
    );
  });

  it("allows json parts to auto-size", () => {
    render(<JsonPart label="Result" value={{ ok: true }} autoHeight />);

    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-height",
      "auto"
    );
    expect(screen.getByTestId("json-editor")).toHaveAttribute(
      "data-max-height",
      "undefined"
    );
  });

  it("renders MCP image results as inline previews with raw JSON behind a toggle", async () => {
    const user = userEvent.setup();
    const value = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    render(<JsonPart label="Result" value={value} />);

    const image = await screen.findByRole("img", {
      name: "Tool result image 1",
    });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Raw" }));

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(value)
    );
  });

  it("keeps MCP image results raw when rendering is disabled", () => {
    const value = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    render(
      <JsonPart
        label="Result"
        value={value}
        mcpToolResultImageRendering="none"
      />
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Images" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Raw" })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(value)
    );
  });
});
