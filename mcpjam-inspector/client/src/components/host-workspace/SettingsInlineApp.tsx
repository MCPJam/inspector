import { useMemo } from "react";
import {
  MCPAppsRendererSurface,
  WidgetHostProvider,
  type WidgetHost,
} from "@mcpjam/widget-react";
import { createThreadAppHost } from "./thread-app-host";
import type { ServerSettingsApp } from "./server-settings-api";

/** One private inline renderer; no modal, transcript registration or model context. */
export function SettingsInlineApp({
  app,
  host,
  serverId,
  serverName,
  toolName,
  signal,
}: {
  app: ServerSettingsApp;
  host: WidgetHost;
  serverId: string;
  serverName: string;
  toolName: string;
  signal: AbortSignal;
}) {
  const owner = useMemo(() => {
    const owned = createThreadAppHost(
      host,
      {
        instanceToken: app.childToken,
        instanceId: app.childToken,
        generation: 1,
        operationId: app.childToken,
        resourceUri: app.resourceUri,
        toolTitle: toolName,
        toolMetadata: app.toolMetadata,
        widgetContent: app.widgetContent,
        appToolsEnabled: app.appToolsEnabled,
      },
      serverId,
    );
    return {
      ...owned,
      environment: {
        ...owned.environment,
        draftHostContext: {
          ...owned.environment.draftHostContext,
          displayMode: "inline",
          availableDisplayModes: ["inline"],
        },
      },
      resolvers: {
        ...owned.resolvers,
        resolveEffectiveMcpAppsCapabilities: (args) => ({
          ...owned.resolvers.resolveEffectiveMcpAppsCapabilities(args),
          availableDisplayModes: ["inline"],
          widgetDisplayModeRequests: "decline",
        }),
      },
    } satisfies WidgetHost;
  }, [host, app, serverId, toolName]);
  return (
    <div
      data-plugin-private="settings"
      className="min-h-64 overflow-hidden rounded-md border"
    >
      <WidgetHostProvider value={owner}>
        <MCPAppsRendererSurface
          serverId={serverId}
          serverName={serverName}
          toolCallId={app.childToken}
          toolName={toolName}
          resourceUri={app.resourceUri}
          toolMetadata={app.toolMetadata}
          toolState="output-available"
          toolInput={{}}
          toolOutput={app.result}
          toolResponseMetadata={app.result._meta}
          hostManagedPresentation
          displayMode="inline"
          onCallTool={(name, args) => app.call(name, args, signal)}
        />
      </WidgetHostProvider>
    </div>
  );
}
