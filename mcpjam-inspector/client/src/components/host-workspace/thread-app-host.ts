import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle } from "./thread-app-api";

/**
 * How an owned App is presented.
 *
 * - `thread` / `global`: an entrypoint (thread, file, quick-action App and
 *   global), presented the way ChatGPT presents them: `fullscreen`, and only
 *   `fullscreen`. Where it is drawn (a right-rail tab or the global takeover)
 *   is the host's choice.
 * - `model`: an App a model's tool call returned into the chat. It is not an
 *   entrypoint: it sits in its message inline, and goes fullscreen and comes
 *   back the way the client allows, like any chat App. Offering it
 *   fullscreen only made every way out (Exit full screen, the App's own
 *   Return, another side-panel tab) snap straight back to fullscreen.
 */
export type ThreadAppPresentation = "thread" | "global" | "model";

type ChatDisplayMode = "inline" | "fullscreen";
const CHAT_DISPLAY_MODES: readonly ChatDisplayMode[] = ["inline", "fullscreen"];
function chatDisplayModes(modes: unknown): ChatDisplayMode[] {
  return Array.isArray(modes)
    ? modes.filter((mode): mode is ChatDisplayMode =>
        (CHAT_DISPLAY_MODES as readonly unknown[]).includes(mode),
      )
    : [...CHAT_DISPLAY_MODES];
}

/** Compose only the actual qualified ports. A normal chat host is not authority. */
export function createThreadAppHost(
  host: WidgetHost,
  handle: ThreadAppHandle,
  serverId: string,
  presentation: ThreadAppPresentation = "thread",
): WidgetHost {
  const model = presentation === "model";
  const unavailable = async () => {
    throw new Error("This App capability is unavailable");
  };
  const {
    "openai/deepLink": _link,
    "openai/modelContext": _context,
    "openai/interactionCursor": _cursor,
    ...draftHostContext
  } = host.environment.draftHostContext ?? {};
  return {
    ...host,
    environment: {
      ...host.environment,
      draftHostContext: model
        ? {
            ...draftHostContext,
            displayMode: "inline",
            availableDisplayModes: chatDisplayModes(
              draftHostContext.availableDisplayModes,
            ),
          }
        : {
            ...draftHostContext,
            displayMode: "fullscreen",
            availableDisplayModes: ["fullscreen"],
          },
    },
    surface: {
      ...host.surface,
      playgroundCspMode: "widget-declared",
      // An entrypoint is fullscreen by the host's choice, so an App that
      // declares only `inline` still opens rather than being refused.
      ...(model ? {} : { fixedDisplayMode: "fullscreen" as const }),
    },
    resolvers: {
      // window.openai follows the client's own "Inject window.openai" setting,
      // the same as in chat (`host.resolvers.resolveEffectiveCompatRuntime`).
      // Extensions run on the MCP Apps bridge either way; this keeps older
      // Apps SDK-style Apps working in the side panel and the takeover.
      ...host.resolvers,
      resolveEffectiveHostCapabilities: (args) => {
        const native = host.resolvers.resolveEffectiveHostCapabilities(args);
        const matrix = host.resolvers.resolveEffectiveMcpAppsCapabilities(args);
        return handle.appToolsEnabled &&
          native.serverTools &&
          matrix.serverTools
          ? { serverTools: native.serverTools }
          : {};
      },
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...host.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        availableDisplayModes: model
          ? chatDisplayModes(
              host.resolvers.resolveEffectiveMcpAppsCapabilities(args)
                .availableDisplayModes,
            )
          : (
              host.resolvers.resolveEffectiveMcpAppsCapabilities(args)
                .availableDisplayModes ?? ["fullscreen"]
            ).filter((mode) => mode === "fullscreen"),
        serverTools:
          handle.appToolsEnabled &&
          !!host.resolvers.resolveEffectiveHostCapabilities(args).serverTools &&
          host.resolvers.resolveEffectiveMcpAppsCapabilities(args).serverTools,
        serverResources: false,
        message: false,
        updateModelContext: false,
        openLinks: false,
        downloadFile: false,
        requestTeardown: false,
        // A chat App asks to change modes under the client's own policy.
        widgetDisplayModeRequests: model
          ? host.resolvers.resolveEffectiveMcpAppsCapabilities(args)
              .widgetDisplayModeRequests
          : "decline",
      }),
    },
    services: {
      fetchWidgetContent: async (request) => {
        if (
          request.resourceUri !== handle.resourceUri ||
          request.serverId !== serverId
        )
          throw new Error("App resource changed");
        return handle.widgetContent;
      },
      readResource: unavailable,
      listResources: unavailable,
      listPrompts: unavailable,
      listResourceTemplates: unavailable,
      authFetch: unavailable,
    },
  };
}
