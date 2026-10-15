import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetSurfaceHost } from "../widget-surface-host";
import { useWidgetSurfaceStore } from "../widget-surface-store";
import { WidgetHostProvider, useWidgetHost } from "../widget-host-context";
import type { WidgetHost } from "../widget-host";
import type { MCPAppsRendererProps } from "../mcp-apps-renderer";

vi.mock("../mcp-apps-renderer", () => ({
  MCPAppsRendererSurface: () => {
    const host = useWidgetHost();
    useEffect(() => {
      void host.services.fetchWidgetContent({} as never);
    }, [host]);
    return <span>App surface</span>;
  },
}));
const props = {
  toolCallId: "call",
  chatSessionId: "thread",
  serverId: "saved-id",
  resourceUri: "ui://app",
} as MCPAppsRendererProps;
function adapter() {
  return {
    services: {
      fetchWidgetContent: vi.fn().mockResolvedValue({ html: "owned" }),
    },
  } as unknown as WidgetHost;
}
afterEach(() => {
  cleanup();
  useWidgetSurfaceStore.getState().clearChatSession("thread");
});
describe("retained surface authority", () => {
  it("uses the registered owned adapter through parking and reattachment", async () => {
    const outer = adapter();
    const owned = adapter();
    const store = useWidgetSurfaceStore.getState();
    store.upsertRegistration("owned", "call", props, owned);
    render(
      <WidgetHostProvider value={outer}>
        <WidgetSurfaceHost chatSessionId="thread" />
      </WidgetHostProvider>
    );
    await waitFor(() =>
      expect(owned.services.fetchWidgetContent).toHaveBeenCalledTimes(1)
    );
    expect(outer.services.fetchWidgetContent).not.toHaveBeenCalled();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    act(() => store.setAnchor("owned", "call", anchor));
    act(() => store.setAnchor("owned", "call", null));
    expect(owned.services.fetchWidgetContent).toHaveBeenCalledTimes(1);
    expect(outer.services.fetchWidgetContent).not.toHaveBeenCalled();
    anchor.remove();
  });
  it("preserves ambient host behavior for ordinary unowned registrations", async () => {
    const outer = adapter();
    useWidgetSurfaceStore
      .getState()
      .upsertRegistration("ordinary", "call", props);
    render(
      <WidgetHostProvider value={outer}>
        <WidgetSurfaceHost chatSessionId="thread" />
      </WidgetHostProvider>
    );
    await waitFor(() =>
      expect(outer.services.fetchWidgetContent).toHaveBeenCalledTimes(1)
    );
  });
});
