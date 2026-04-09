import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreePanelLayout } from "../ui/three-panel-layout";

const { mockUseJsonRpcPanelVisibility } = vi.hoisted(() => ({
  mockUseJsonRpcPanelVisibility: vi.fn(),
}));

vi.mock("@/hooks/use-json-rpc-panel", () => ({
  useJsonRpcPanelVisibility: () => mockUseJsonRpcPanelVisibility(),
}));

vi.mock("../logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view">Logger</div>,
}));

const INVALID_LAYOUT_TOTAL_MESSAGE = "Invalid layout total size";

function hasConsoleMessage(
  spy: ReturnType<typeof vi.spyOn>,
  message: string,
) {
  return spy.mock.calls.some((call) =>
    call.some((arg) => typeof arg === "string" && arg.includes(message)),
  );
}

describe("ThreePanelLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseJsonRpcPanelVisibility.mockReset();
  });

  it.each([
    {
      name: "uses valid defaults when the sidebar and logger are visible",
      sidebarVisible: true,
      loggerVisible: true,
    },
    {
      name: "uses valid defaults when only the sidebar is visible",
      sidebarVisible: true,
      loggerVisible: false,
    },
    {
      name: "uses valid defaults when only the logger is visible",
      sidebarVisible: false,
      loggerVisible: true,
    },
    {
      name: "uses valid defaults when only the center panel is visible",
      sidebarVisible: false,
      loggerVisible: false,
    },
  ])("$name", ({ sidebarVisible, loggerVisible }) => {
    mockUseJsonRpcPanelVisibility.mockReturnValue({
      isVisible: loggerVisible,
      toggle: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        render(
          <ThreePanelLayout
            id="test-layout"
            sidebar={<div>Sidebar</div>}
            content={<div>Content</div>}
            sidebarVisible={sidebarVisible}
            onSidebarVisibilityChange={vi.fn()}
            sidebarTooltip="Show sidebar"
            serverName="test-server"
          />,
        ),
      ).not.toThrow();

      expect(screen.getByText("Content")).toBeInTheDocument();

      if (sidebarVisible) {
        expect(screen.getByText("Sidebar")).toBeInTheDocument();
      }

      if (loggerVisible) {
        expect(screen.getByTestId("logger-view")).toBeInTheDocument();
      }

      expect(
        hasConsoleMessage(warnSpy, INVALID_LAYOUT_TOTAL_MESSAGE),
      ).toBe(false);
      expect(
        hasConsoleMessage(errorSpy, INVALID_LAYOUT_TOTAL_MESSAGE),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
