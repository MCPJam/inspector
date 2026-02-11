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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("../../csp-debug-panel", () => ({
  CspDebugPanel: () => null,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: any) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
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

  it("auto-expands once approval is requested after mount", async () => {
    const { rerender } = render(
      <ToolPart part={basePart as any} uiType="mcp-apps" />,
    );

    expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");

    rerender(
      <ToolPart
        part={{ ...basePart, state: "approval-requested" } as any}
        uiType="mcp-apps"
        approvalId="approval-1"
      />,
    );

    await waitFor(() => {
      expect(getHeaderButton()).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("collapses after approval resolves", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ToolPart
        part={{ ...basePart, state: "approval-requested" } as any}
        uiType="mcp-apps"
        approvalId="approval-1"
      />,
    );

    await waitFor(() => {
      expect(getHeaderButton()).toHaveAttribute("aria-expanded", "true");
    });

    const headerButton = getHeaderButton();
    expect(headerButton).toBeTruthy();
    if (headerButton) {
      await user.click(headerButton);
    }

    await user.click(screen.getByRole("button", { name: /^approve$/i }));

    rerender(<ToolPart part={basePart as any} uiType="mcp-apps" />);

    await waitFor(() => {
      expect(getHeaderButton()).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("shows one-time save hint before save view is used", () => {
    render(
      <ToolPart
        part={basePart as any}
        uiType="mcp-apps"
        onSaveView={() => {}}
        canSaveView
      />,
    );

    expect(screen.getByText("Like how it looks? Save it.")).toBeInTheDocument();
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
      />,
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
    expect(window.location.hash).toBe("#views");

    window.location.hash = "#chat-v2";
    rerender(
      <ToolPart
        part={basePart as any}
        uiType="mcp-apps"
        onSaveView={onSaveView}
        canSaveView
      />,
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
    expect(window.location.hash).toBe("#chat-v2");
  });
});
