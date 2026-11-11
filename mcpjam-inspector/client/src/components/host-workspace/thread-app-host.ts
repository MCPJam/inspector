import type { WidgetHost, WidgetHostServices } from "@mcpjam/widget-react";
import type { DisplayBehavior } from "@mcpjam/sdk/widget-runtime";
import type { ThreadAppHandle } from "./thread-app-api";
import { logExtensionEvent } from "./extension-log";
import { createSandboxViewServices } from "../chat-v2/thread/mcp-apps/sandbox-view-services";

/**
 * How an owned App is presented.
 *
 * - `thread` / `global`: an entrypoint (thread, file, quick-action App and
 *   global), presented the way ChatGPT presents them: `fullscreen`, and only
 *   `fullscreen`. Where it is drawn (a right-rail tab or the global takeover)
 *   is the host's choice.
 * - `inline`: a global entry App that can't go fullscreen, drawn at the top
 *   of a new chat where the client opens those inline (Claude): `inline`,
 *   and only `inline`.
 * - `model`: an App a model's tool call returned into the chat. It is not an
 *   entrypoint: it sits in its message inline, and goes fullscreen and comes
 *   back the way the client allows, like any chat App. Offering it
 *   fullscreen only made every way out (Exit full screen, the App's own
 *   Return, another side-panel tab) snap straight back to fullscreen.
 */
export type ThreadAppPresentation = "thread" | "global" | "inline" | "model";

/** How an owned App's row is presented. */
export function rowPresentation(row: {
  inline?: true;
  declaration: { kind: string };
}): ThreadAppPresentation {
  if (row.inline) return "inline";
  return row.declaration.kind === "global" ? "global" : "thread";
}

type ChatDisplayMode = "inline" | "fullscreen";
const CHAT_DISPLAY_MODES: readonly ChatDisplayMode[] = ["inline", "fullscreen"];
function chatDisplayModes(modes: unknown): ChatDisplayMode[] {
  return Array.isArray(modes)
    ? modes.filter((mode): mode is ChatDisplayMode =>
        (CHAT_DISPLAY_MODES as readonly unknown[]).includes(mode),
      )
    : [...CHAT_DISPLAY_MODES];
}

type DocumentServices = Pick<
  WidgetHostServices,
  "prepareSandboxView" | "releaseSandboxView"
>;
const documentHosts = new WeakMap<
  ThreadAppHandle,
  { key: string; html: string | undefined; services: DocumentServices }
>();

/** Presentation changes keep the admission ports that own the live document. */
function ownedDocumentServices(
  host: WidgetHost,
  handle: ThreadAppHandle,
  serverId: string,
  projectId?: string,
): DocumentServices {
  const source = {
    serverId,
    resourceUri: handle.resourceUri,
    toolCallId: handle.operationId,
  };
  const html = handle.widgetContent?.html;
  const key = JSON.stringify([projectId, source]);
  const cached = projectId ? documentHosts.get(handle) : undefined;
  if (cached?.key === key && cached.html === html) return cached.services;
  const documentHost = projectId
    ? createSandboxViewServices(() => true, () => ({ projectId, serverId }))
    : host.services;
  const prepareView = documentHost?.prepareSandboxView;
  const releaseView = documentHost?.releaseSandboxView;
  const admittedViews = new Set<string>();
  const services: DocumentServices = prepareView && releaseView
    ? {
        prepareSandboxView: async (request, signal) => {
          if (
            request.source.serverId !== serverId ||
            request.source.resourceUri !== source.resourceUri ||
            request.html !== html
          ) throw new Error("App resource changed");
          const view = await prepareView({ ...request, source }, signal);
          admittedViews.add(view.admissionId);
          return view;
        },
        releaseSandboxView: async ({ admissionId }) => {
          if (admittedViews.delete(admissionId)) await releaseView({ admissionId });
        },
      }
    : {};
  if (projectId) documentHosts.set(handle, { key, html, services });
  return services;
}

/** Apps whose ignored preference is already in Logs: one row per App. */
const warnedPreferences = new WeakSet<ThreadAppHandle>();

/** A `_meta.ui.preferredDisplayMode` that isn't a mode is ignored; say so once. */
function warnIgnoredPreferredDisplayMode(
  handle: ThreadAppHandle,
  serverId: string,
) {
  const ignored = handle.widgetContent?.ignoredPreferredDisplayMode;
  if (ignored === undefined || warnedPreferences.has(handle)) return;
  warnedPreferences.add(handle);
  logExtensionEvent({
    serverId,
    label: "display-mode",
    level: "warning",
    message: `${handle.toolTitle}'s resource sets _meta.ui.preferredDisplayMode to ${ignored}, which MCPJam ignores. Set it to "fullscreen" or "inline".`,
    detail: { resourceUri: handle.resourceUri, preferredDisplayMode: ignored },
  });
}

/** Compose only the actual qualified ports. A normal chat host is not authority.
 * `displayBehavior` is the client's display behavior while its Display modes
 * extension is on: under `hint-first` the App starts in the mode OpenAI's
 * rules pick (see `openAIDisplayModes` in `@mcpjam/sdk/widget-runtime`);
 * otherwise it starts inline. */
export function createThreadAppHost(
  host: WidgetHost,
  handle: ThreadAppHandle,
  serverId: string,
  presentation: ThreadAppPresentation = "thread",
  {
    displayBehavior,
    projectId,
  }: {
    displayBehavior?: DisplayBehavior;
    /** Captured owner project; contributed servers need no ambient name lookup. */
    projectId?: string;
  } = {},
): WidgetHost {
  const model = presentation === "model";
  const fixed: ChatDisplayMode =
    presentation === "inline" ? "inline" : "fullscreen";
  const unavailable = async () => {
    throw new Error("This App capability is unavailable");
  };
  const documentServices = ownedDocumentServices(host, handle, serverId, projectId);
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
            ...(displayBehavior?.start === "hint-first"
              ? {}
              : { displayMode: "inline" }),
            availableDisplayModes: chatDisplayModes(
              draftHostContext.availableDisplayModes,
            ),
          }
        : {
            ...draftHostContext,
            displayMode: fixed,
            availableDisplayModes: [fixed],
          },
    },
    surface: {
      ...host.surface,
      playgroundCspMode: "widget-declared",
      // An entrypoint's mode is the host's choice, so an App that declares
      // only `inline` still opens rather than being refused.
      ...(model ? {} : { fixedDisplayMode: fixed }),
      ...(displayBehavior ? { displayBehavior } : {}),
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
                .availableDisplayModes ?? [fixed]
            ).filter((mode) => mode === fixed),
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
      ...documentServices,
      fetchWidgetContent: async (request) => {
        if (
          request.resourceUri !== handle.resourceUri ||
          request.serverId !== serverId
        )
          throw new Error("App resource changed");
        if (displayBehavior?.hints === "ui")
          warnIgnoredPreferredDisplayMode(handle, serverId);
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
