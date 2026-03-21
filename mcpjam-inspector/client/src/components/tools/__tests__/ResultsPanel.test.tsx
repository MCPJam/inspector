import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultsPanel } from "../ResultsPanel";

const { mockJsonEditor } = vi.hoisted(() => ({
  mockJsonEditor: vi.fn((props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  )),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
  },
  detectUIType: () => null,
}));

describe("ResultsPanel", () => {
  beforeEach(() => {
    mockJsonEditor.mockClear();
  });

  it("renders parsed JSON from a text content block instead of the raw MCP envelope", () => {
    render(
      <ResultsPanel
        error=""
        structuredContentValid={false}
        result={{
          content: [
            {
              type: "text",
              text: '{"users":[{"id":"1","name":"Marcelo"}],"hasNextPage":false}',
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toBeInTheDocument();
    expect(mockJsonEditor.mock.calls.map(([props]) => props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: {
            users: [{ id: "1", name: "Marcelo" }],
            hasNextPage: false,
          },
          readOnly: true,
          showToolbar: false,
          height: "100%",
        }),
      ]),
    );
  });

  it("keeps the raw result when the text content is not structured JSON", () => {
    const result = {
      content: [{ type: "text", text: "Hello, World!" }],
    };

    render(
      <ResultsPanel error="" structuredContentValid={false} result={result} />,
    );

    expect(mockJsonEditor.mock.calls.map(([props]) => props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: result,
        }),
      ]),
    );
  });
});
