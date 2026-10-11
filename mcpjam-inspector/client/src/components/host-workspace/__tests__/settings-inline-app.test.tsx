import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import { SettingsInlineApp } from "../SettingsInlineApp";
import type { ServerSettingsApp } from "../server-settings-api";
const seen = vi.hoisted(() => ({ host: undefined as unknown }));
vi.mock("@mcpjam/widget-react", () => ({
  WidgetHostProvider: ({ value, children }: any) => {
    seen.host = value;
    return children;
  },
  MCPAppsRendererSurface: () => null,
}));
afterEach(cleanup);
it("keeps private settings Apps inline even when the workspace permits fullscreen", () => {
  const host = {
    environment: { draftHostContext: { displayMode: "fullscreen" } },
    surface: {},
    services: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({ serverTools: {} }),
      resolveEffectiveMcpAppsCapabilities: () => ({
        serverTools: true,
        availableDisplayModes: ["inline", "fullscreen"],
        widgetDisplayModeRequests: "accept",
      }),
    },
  } as unknown as WidgetHost;
  render(
    <SettingsInlineApp
      host={host}
      app={
        {
          childToken: "child",
          widgetContent: { html: "" },
          result: { content: [] },
        } as unknown as ServerSettingsApp
      }
      serverId="saved"
      serverName="Server"
      toolName="settings"
      signal={new AbortController().signal}
    />,
  );
  const owned = seen.host as WidgetHost;
  expect(owned.environment.draftHostContext).toMatchObject({
    displayMode: "inline",
    availableDisplayModes: ["inline"],
  });
  expect(
    owned.resolvers.resolveEffectiveMcpAppsCapabilities({
      hostStyle: "chatgpt",
    }),
  ).toMatchObject({
    availableDisplayModes: ["inline"],
    widgetDisplayModeRequests: "decline",
  });
});
