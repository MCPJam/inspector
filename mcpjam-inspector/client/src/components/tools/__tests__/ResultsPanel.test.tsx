import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MCP_UI_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { ResultsPanel } from "../ResultsPanel";
import { ActiveHostCapsResolverProvider } from "@/contexts/active-host-client-capabilities-context";

const { mockJsonEditor, mockDetectUIType, mockReadResource } = vi.hoisted(
  () => ({
    mockJsonEditor: vi.fn((props: any) => (
      <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
    )),
    mockDetectUIType: vi.fn(),
    mockReadResource: vi.fn(),
  })
);

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

vi.mock("@/lib/apis/mcp-resources-api", () => ({
  readResource: (...args: unknown[]) => mockReadResource(...args),
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
    mockReadResource.mockReset();
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

  it("defaults image tool results to inline previews", async () => {
    render(
      <ResultsPanel
        error=""
        structuredContentValid={false}
        result={{
          content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        }}
      />
    );

    const image = await screen.findByRole("img", {
      name: "Tool result image 1",
    });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    expect(screen.getByRole("radio", { name: "Images" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Raw" })).toBeInTheDocument();
    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
  });

  it("switches image results between preview and raw MCP JSON", async () => {
    const user = userEvent.setup();
    const result = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    render(
      <ResultsPanel error="" structuredContentValid={false} result={result} />
    );

    expect(
      await screen.findByRole("img", { name: "Tool result image 1" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Raw" }));

    expect(screen.getByTestId("json-editor")).toBeInTheDocument();
    expect(mockJsonEditor.mock.calls.map(([props]) => props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: result,
          readOnly: true,
          showToolbar: false,
          height: "100%",
        }),
      ])
    );

    await user.click(screen.getByRole("radio", { name: "Images" }));

    expect(
      screen.getByRole("img", { name: "Tool result image 1" })
    ).toBeInTheDocument();
  });

  it("renders linked image resources after resolving them through MCP resources/read", async () => {
    let resolveReadResource: (value: unknown) => void = () => {};
    mockReadResource.mockReturnValue(
      new Promise((resolve) => {
        resolveReadResource = resolve;
      })
    );

    render(
      <ResultsPanel
        error=""
        structuredContentValid={false}
        serverName="qa-server"
        result={{
          content: [
            {
              type: "resource_link",
              uri: "example://linked-image.png",
              mimeType: "image/png",
            },
          ],
        }}
      />
    );

    expect(screen.getByText("Resolving images...")).toBeInTheDocument();
    expect(mockReadResource).toHaveBeenCalledWith(
      "qa-server",
      "example://linked-image.png"
    );

    await act(async () => {
      resolveReadResource({
        contents: [
          {
            uri: "example://linked-image.png",
            blob: "aGVsbG8=",
            mimeType: "image/png",
          },
        ],
      });
    });

    const image = await screen.findByRole("img", {
      name: "Tool result image 1",
    });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
  });

  it("falls back to raw JSON when linked image resolution fails", async () => {
    const result = {
      content: [
        {
          type: "resource_link",
          uri: "example://linked-image.png",
          mimeType: "image/png",
        },
      ],
    };
    mockReadResource.mockRejectedValue(new Error("read failed"));

    render(
      <ResultsPanel
        error=""
        structuredContentValid={false}
        serverName="qa-server"
        result={result}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("json-editor")).toBeInTheDocument();
    });
    expect(mockJsonEditor.mock.calls.map(([props]) => props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: result,
        }),
      ])
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  describe("Playground banner gate", () => {
    const uiResult = {
      content: [{ type: "text", text: "{}" }],
    };

    it("renders the Playground banner when the host supports widgets", () => {
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

  describe("trace context", () => {
    const traceparent =
      "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01";

    it("surfaces the trace id when the result carries a traceparent", async () => {
      render(
        <ResultsPanel
          error=""
          structuredContentValid={false}
          result={{
            content: [{ type: "text", text: "{}" }],
            _meta: { traceparent, baggage: "userId=alice" },
          }}
        />
      );

      expect(screen.getByText("Trace")).toBeInTheDocument();
      expect(
        screen.getByText("0af7651916cd43dd8448eb211c80319c")
      ).toBeInTheDocument();
      // Specifics — including the untrusted `baggage` — stay behind the expand.
      expect(screen.queryByText("userId=alice")).not.toBeInTheDocument();

      await userEvent.click(screen.getByText("Trace"));
      expect(screen.getByText("00f067aa0ba902b7")).toBeInTheDocument();
      expect(screen.getByText("userId=alice")).toBeInTheDocument();
    });

    it("renders nothing for a result with no trace context or a malformed one", () => {
      const { rerender } = render(
        <ResultsPanel
          error=""
          structuredContentValid={false}
          result={{ content: [{ type: "text", text: "{}" }] }}
        />
      );
      expect(screen.queryByText("Trace")).not.toBeInTheDocument();

      rerender(
        <ResultsPanel
          error=""
          structuredContentValid={false}
          result={{
            content: [{ type: "text", text: "{}" }],
            _meta: { traceparent: "00-nope-01" },
          }}
        />
      );
      expect(screen.queryByText("Trace")).not.toBeInTheDocument();
    });
  });
});
