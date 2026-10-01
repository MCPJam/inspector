import type { ComponentProps } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetHostProvider } from "../widget-host-context";
import type { WidgetHost } from "../widget-host";
import { McpAppsModal } from "../mcp-apps-modal";

const sandbox = vi.hoisted(() => ({ props: null as any }));
vi.mock("../sandboxed-iframe", () => ({
  SandboxedIframe: (props: any) => {
    sandbox.props = props;
    return null;
  },
}));

describe("modal CSP forwarding", () => {
  it("routes applied policy and violations separately and retires the modal mount", async () => {
    const onCspApplied = vi.fn();
    const onCspViolation = vi.fn();
    const clearCspMount = vi.fn();
    const host = {
      services: {
        fetchWidgetContent: vi.fn().mockResolvedValue({ html: "<p>App</p>" }),
      },
      components: { Modal: ({ children }: any) => <div>{children}</div> },
      surface: { sandboxOrigin: "" },
      debug: { clearCspMount },
    } as unknown as WidgetHost;
    const props = {
      open: true,
      toolCallId: "app",
      hostContextRef: { current: null },
      themeModeRef: { current: "light" },
      toolInputRef: { current: undefined },
      toolOutputRef: { current: undefined },
      onCspApplied,
      onCspViolation,
    } as unknown as ComponentProps<typeof McpAppsModal>;
    const { unmount } = render(
      <WidgetHostProvider value={host}>
        <McpAppsModal {...props} />
      </WidgetHostProvider>,
    );
    await waitFor(() => expect(sandbox.props).toBeTruthy());
    const applied = new MessageEvent("message", {
      data: {
        type: "mcpjam:csp-applied",
        mountId: "modal:1",
        csp: "img-src data: blob:",
      },
    });
    act(() => sandbox.props.onMessage(applied));
    expect(onCspApplied).toHaveBeenCalledWith(applied);
    expect(onCspViolation).not.toHaveBeenCalled();
    const violation = new MessageEvent("message", {
      data: {
        type: "mcp-apps:csp-violation",
        mountId: "modal:1",
        directive: "img-src",
      },
    });
    act(() => sandbox.props.onMessage(violation));
    expect(onCspViolation).toHaveBeenCalledWith(violation);
    expect(onCspApplied).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearCspMount).toHaveBeenCalledWith("app", "modal:1");
  });
});
