import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { SandboxedIframeHandle } from "@/components/ui/sandboxed-iframe";
import { McpAppsLayout } from "../mcp-apps-layout";

vi.mock("@/components/ui/sandboxed-iframe", () => ({
  SandboxedIframe: (props: { className?: string }) => (
    <div data-testid="sandboxed-iframe" className={props.className} />
  ),
}));

vi.mock("lucide-react", () => ({
  X: (props: Record<string, unknown>) => <div {...props} />,
}));

const baseProps = {
  toolState: "output-available" as const,
  loadError: null,
  widgetHtml: "<html></html>",
  showWidget: true,
  effectiveDisplayMode: "inline" as const,
  isPlaygroundActive: false,
  playgroundDeviceType: "desktop" as const,
  toolName: "weather",
  toolCallId: "call-1",
  pipWidgetId: null,
  resourceUri: "ui://weather",
  prefersBorder: true,
  iframeStyle: {},
  sandboxRef: createRef<SandboxedIframeHandle>(),
  widgetCsp: undefined,
  widgetPermissions: undefined,
  widgetPermissive: false,
  onSandboxMessage: vi.fn(),
  onSetDisplayMode: vi.fn(),
  onExitPip: vi.fn(),
  modal: null,
};

describe("McpAppsLayout", () => {
  it("uses inline container classes by default", () => {
    const { container } = render(<McpAppsLayout {...baseProps} />);
    expect(container.firstElementChild?.className).toContain(
      "mt-3 space-y-2 relative group",
    );
  });

  it("uses fullscreen container classes when mode is fullscreen", () => {
    const { container } = render(
      <McpAppsLayout {...baseProps} effectiveDisplayMode="fullscreen" />,
    );
    expect(container.firstElementChild?.className).toContain(
      "fixed inset-0 z-40 w-full h-full",
    );
  });

  it("renders pip floating container in desktop mode", () => {
    const { container } = render(
      <McpAppsLayout {...baseProps} effectiveDisplayMode="pip" />,
    );
    expect(container.firstElementChild?.className).toContain(
      "fixed top-4 left-1/2 -translate-x-1/2",
    );
    expect(screen.getByTestId("sandboxed-iframe")).toBeTruthy();
  });
});
