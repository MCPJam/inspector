import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolPart } from "../tool-part";

vi.mock("lucide-react", () => {
  const s = (props: any) => <div {...props} />;
  return {
    Box: s,
    Check: s,
    ChevronDown: s,
    Database: s,
    Layers: s,
    Loader2: s,
    Maximize2: s,
    MessageCircle: s,
    PictureInPicture2: s,
    Shield: s,
    ShieldCheck: s,
    ShieldX: s,
    Terminal: s,
    X: s,
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => selector({ themeMode: "light" }),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) =>
    selector({
      widgets: new Map(),
    }),
}));

vi.mock("../../thread-helpers", () => ({
  getToolNameFromType: () => "test-tool",
  getToolStateMeta: () => ({
    Icon: (props: any) => <div data-testid="status-icon" {...props} />,
    className: "",
  }),
  safeStringify: (v: any) => JSON.stringify(v),
  isDynamicTool: () => false,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: { MCP_APPS: "mcp-apps", OPENAI_SDK: "openai-apps" },
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@mcpjam/design-system/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("../../sandbox-debug-panel", () => ({
  SandboxDebugPanel: () => null,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: any) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
  ),
}));

vi.mock("../text-part", () => ({
  TextPart: ({ text }: { text: string }) => (
    <div data-testid="text-part">{text}</div>
  ),
}));

const basePart = {
  type: "tool-invocation" as const,
  toolName: "test-tool",
  toolCallId: "call-1",
  state: "output-available",
  input: {},
  output: {},
};

const getHeaderButton = () =>
  screen
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-expanded") !== null);

describe("ToolPart approval expansion", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
  });

  it("renders the approval pill when approval is requested", async () => {
    const { rerender } = render(
      <ToolPart part={basePart as any} uiType="mcp-apps" />
    );

    expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: /^approve$/i })
    ).not.toBeInTheDocument();

    rerender(
      <ToolPart
        part={{ ...basePart, state: "approval-requested" } as any}
        uiType="mcp-apps"
        approvalId="approval-1"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^approve$/i })
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();
  });

  it("returns to a collapsed card after approval resolves", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ToolPart
        part={{ ...basePart, state: "approval-requested" } as any}
        uiType="mcp-apps"
        approvalId="approval-1"
      />
    );

    const approveButton = await screen.findByRole("button", {
      name: /^approve$/i,
    });
    await user.click(approveButton);

    rerender(<ToolPart part={basePart as any} uiType="mcp-apps" />);

    await waitFor(() => {
      expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");
    });
    expect(
      screen.queryByRole("button", { name: /^approve$/i })
    ).not.toBeInTheDocument();
  });

  it("does not show a one-time save hint above save view", () => {
    render(
      <ToolPart
        part={basePart as any}
        uiType="mcp-apps"
        onSaveView={() => {}}
        canSaveView
      />
    );

    expect(
      screen.queryByText("Like how it looks? Save it.")
    ).not.toBeInTheDocument();
  });

  it("marks save button as used and redirects to Views once after first successful save", async () => {
    const user = userEvent.setup();

    const onSaveView = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ToolPart
        part={basePart as any}
        uiType="mcp-apps"
        onSaveView={onSaveView}
        canSaveView
      />
    );

    const saveButton = screen
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-expanded") === null);
    expect(saveButton).toBeTruthy();
    if (saveButton) {
      await user.click(saveButton);
    }

    await waitFor(() => {
      expect(onSaveView).toHaveBeenCalledTimes(1);
    });
    expect(localStorage.getItem("mcpjam-save-view-button-used")).toBe("true");
    expect(window.location.pathname).toBe("/views");

    window.history.replaceState({}, "", "/chat-v2");
    rerender(
      <ToolPart
        part={basePart as any}
        uiType="mcp-apps"
        onSaveView={onSaveView}
        canSaveView
      />
    );

    const saveButtonAgain = screen
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-expanded") === null);
    expect(saveButtonAgain).toBeTruthy();
    if (saveButtonAgain) {
      await user.click(saveButtonAgain);
    }

    await waitFor(() => {
      expect(onSaveView).toHaveBeenCalledTimes(2);
    });
    expect(window.location.pathname).toBe("/chat-v2");
  });

  it("keeps attached readable output collapsed until the header is clicked", async () => {
    const user = userEvent.setup();

    render(
      <ToolPart
        part={
          {
            ...basePart,
            traceDisplayText: "# Excalidraw Element Format",
            traceDisplayMode: "markdown",
          } as any
        }
        uiType="mcp-apps"
      />
    );

    expect(screen.queryByTestId("text-part")).not.toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    expect(getHeaderButton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("text-part")).toHaveTextContent(
      "# Excalidraw Element Format"
    );

    if (headerButton) {
      await user.click(headerButton);
    }

    expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("text-part")).not.toBeInTheDocument();
  });

  it("renders MCP image tool results inline by default", async () => {
    const user = userEvent.setup();
    const output = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    render(
      <ToolPart
        part={
          {
            ...basePart,
            input: undefined,
            output,
          } as any
        }
        uiType="mcp-apps"
      />
    );

    const image = await screen.findByRole("img", {
      name: "Tool result image 1",
    });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    expect(
      screen.queryByRole("radio", { name: "Images" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Raw" })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(output)
    );
  });

  it("renders MCP image tool results in the expanded panel when configured", async () => {
    const user = userEvent.setup();
    const output = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    render(
      <ToolPart
        part={
          {
            ...basePart,
            input: undefined,
            output,
          } as any
        }
        uiType="mcp-apps"
        mcpToolResultImageRendering={{ placement: "collapsed" }}
      />
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    const image = await screen.findByRole("img", {
      name: "Tool result image 1",
    });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Raw" }));

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(output)
    );
  });

  it("keeps MCP image tool results raw when rendering is disabled", async () => {
    const user = userEvent.setup();
    const output = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    render(
      <ToolPart
        part={
          {
            ...basePart,
            input: undefined,
            output,
          } as any
        }
        uiType="mcp-apps"
        mcpToolResultImageRendering={{ placement: "none" }}
      />
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Images" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Raw" })
    ).not.toBeInTheDocument();

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(output)
    );
  });

  it("does not render generic media when the raw MCP source shape is disabled", async () => {
    const modelOutput = {
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    };
    const rawEmbeddedResult = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "example://embedded-image.png",
            blob: "aGVsbG8=",
            mimeType: "image/png",
          },
        },
      ],
    };

    render(
      <ToolPart
        part={
          {
            ...basePart,
            input: undefined,
            output: modelOutput,
          } as any
        }
        rawOutput={rawEmbeddedResult}
        uiType="mcp-apps"
        mcpToolResultImageRendering={{
          placement: "inline",
          directContent: { image: true },
          embeddedResources: { blob: { image: false } },
          linkedResources: { blob: { image: true } },
        }}
      />
    );

    await waitFor(() => {
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });

  it("does not render model-visible media without a raw MCP source shape", async () => {
    const modelOutput = {
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    };

    render(
      <ToolPart
        part={
          {
            ...basePart,
            input: undefined,
            output: modelOutput,
          } as any
        }
        uiType="mcp-apps"
        mcpToolResultImageRendering={{
          placement: "inline",
          directContent: { image: true },
          embeddedResources: { blob: { image: true } },
          linkedResources: { blob: { image: true } },
        }}
      />
    );

    await waitFor(() => {
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });

  it("reuses attached readable output instead of rendering a duplicate result json block", async () => {
    const user = userEvent.setup();

    render(
      <ToolPart
        part={
          {
            ...basePart,
            input: { prompt: "read me" },
            output: { type: "json", value: { ignored: true } },
            traceDisplayText: "Readable output",
            traceDisplayMode: "markdown",
          } as any
        }
        uiType="mcp-apps"
      />
    );

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    expect(screen.getByTestId("text-part")).toHaveTextContent(
      "Readable output"
    );
    expect(screen.getAllByTestId("json-editor")).toHaveLength(1);
  });

  it("does not expand attached readable output in minimal mode", async () => {
    const user = userEvent.setup();

    render(
      <ToolPart
        part={
          {
            ...basePart,
            traceDisplayText: "Readable output",
            traceDisplayMode: "markdown",
          } as any
        }
        uiType="mcp-apps"
        minimalMode
      />
    );

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("text-part")).not.toBeInTheDocument();
  });
});
