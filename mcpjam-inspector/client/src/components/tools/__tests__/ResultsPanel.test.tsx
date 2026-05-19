import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MCP_UI_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { ResultsPanel } from "../ResultsPanel";
import { ActiveHostCapsResolverProvider } from "@/contexts/active-host-client-capabilities-context";

const { mockJsonEditor, mockDetectUIType } = vi.hoisted(() => ({
  mockJsonEditor: vi.fn((props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  )),
  mockDetectUIType: vi.fn(),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
  },
  detectUIType: (...args: unknown[]) => mockDetectUIType(...args),
}));

describe("ResultsPanel", () => {
  beforeEach(() => {
    mockJsonEditor.mockClear();
    mockDetectUIType.mockReset();
    mockDetectUIType.mockReturnValue(null);
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
      />
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
      ])
    );
  });

  it("keeps the raw result when the text content is not structured JSON", () => {
    const result = {
      content: [{ type: "text", text: "Hello, World!" }],
    };

    render(
      <ResultsPanel error="" structuredContentValid={false} result={result} />
    );

    expect(mockJsonEditor.mock.calls.map(([props]) => props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: result,
        }),
      ])
    );
  });

  describe("App Builder banner gate", () => {
    const uiResult = {
      content: [{ type: "text", text: "{}" }],
    };

    it("renders the App Builder banner when the host supports widgets", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const caps = {
        extensions: {
          [MCP_UI_EXTENSION_ID]: {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      };
      render(
        <ActiveHostCapsResolverProvider value={() => caps}>
          <ResultsPanel
            error=""
            structuredContentValid={false}
            result={uiResult}
          />
        </ActiveHostCapsResolverProvider>
      );
      expect(screen.getByText(/This tool renders UI/i)).toBeInTheDocument();
    });

    it("suppresses the banner when the host strips the UI extension (Codex)", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const codexCaps = { elicitation: {} };
      render(
        <ActiveHostCapsResolverProvider value={() => codexCaps}>
          <ResultsPanel
            error=""
            structuredContentValid={false}
            result={uiResult}
          />
        </ActiveHostCapsResolverProvider>
      );
      expect(
        screen.queryByText(/This tool renders UI/i)
      ).not.toBeInTheDocument();
    });
  });
});
