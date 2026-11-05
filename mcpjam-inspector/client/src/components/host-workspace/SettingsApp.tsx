import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type ComponentProps,
} from "react";
import {
  MCPAppsRendererSurface,
  WidgetHostProvider,
  type WidgetHost,
} from "@mcpjam/widget-react";
import {
  openAIDisplayModes,
  negotiateResourceDisplayModes,
  pickOpenAIDisplayMode,
} from "@mcpjam/sdk/widget-runtime";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useSavedClient } from "@/contexts/saved-client-context";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { pluginExtensionsForHost } from "@/lib/client-config-v2-plugin-extensions";
import {
  negotiateRetainedAppHost,
  withCurrentHostContext,
} from "./retained-app-host";
import { createThreadAppHost } from "./thread-app-host";
import type { ThreadAppScope } from "./thread-app-api";
import type { ServerSettingsApp } from "./server-settings-api";
import {
  registerComposerSlot,
  useComposerForms,
} from "../elicitation/composer-form-store";
import { useFormDialogFocus } from "../elicitation/use-form-dialog-focus";
import {
  SETTINGS_FULLSCREEN_STYLE,
  useSettingsDialogPresentation,
  type SettingsDisplayMode,
} from "./settings-dialog-presentation";

const isMode = (value: unknown): value is SettingsDisplayMode =>
  value === "inline" || value === "fullscreen";
/** Resource hints narrow the actual profile before the guest can initialize. */
export function settingsAppModes(
  host: WidgetHost,
  app: ServerSettingsApp,
  openAIRules = host.surface.openAIDisplayModes === true,
) {
  const environment = host.environment;
  const matrix = host.resolvers
    .resolveEffectiveMcpAppsCapabilities({
      hostStyle: environment.isPlaygroundActive
        ? environment.sharedHostStyle
        : environment.scenarioHostStyle,
    })
    .availableDisplayModes.filter(isMode);
  const configured = environment.draftHostContext?.availableDisplayModes;
  const modes = Array.isArray(configured)
    ? matrix.filter((mode) => configured.includes(mode))
    : matrix;
  const allowed = (
    openAIRules ? openAIDisplayModes : negotiateResourceDisplayModes
  )(modes, app.widgetContent.resourceDisplayHints);
  const requested =
    environment.draftHostContext?.displayMode ??
    (environment.isPlaygroundActive
      ? environment.playgroundDisplayMode
      : "inline");
  return {
    allowed,
    initial: openAIRules
      ? pickOpenAIDisplayMode(allowed, app.widgetContent.resourceDisplayHints)
      : (allowed.find((mode) => mode === requested) ?? allowed[0]),
  };
}

/** One retained guest: its existing Settings dialog or a single workspace App dialog. */
export function SettingsApp({
  app,
  host,
  serverId,
  serverName,
  toolName,
  signal,
  scope,
  onClose,
  returnFocusTo,
}: {
  app: ServerSettingsApp;
  host: WidgetHost;
  serverId: string;
  serverName: string;
  toolName: string;
  signal: AbortSignal;
  scope: ThreadAppScope;
  onClose(): void;
  returnFocusTo?: HTMLElement;
}) {
  const dialog = useSettingsDialogPresentation();
  const saved = useSavedClient();
  const profile = useActiveMcpProfile();
  const openAIRules =
    host.surface.openAIDisplayModes ??
    pluginExtensionsForHost(
      saved ?? {
        hostStyle: host.environment.sharedHostStyle,
        mcpProfile: profile,
      },
    ).capabilities.displayModes;
  const [handle] = useState(() => ({
    instanceToken: app.childToken,
    instanceId: app.childToken,
    generation: 1,
    operationId: app.childToken,
    resourceUri: app.resourceUri,
    toolTitle: toolName,
    toolMetadata: app.toolMetadata,
    widgetContent: app.widgetContent,
    appToolsEnabled: app.appToolsEnabled,
  }));
  const currentOwned = useMemo(
    () =>
      createThreadAppHost(host, handle, serverId, "model", {
        openAIDisplayModes: openAIRules,
      }),
    [host, handle, serverId, openAIRules],
  );
  const [opening] = useState(() => {
    const modes = settingsAppModes(host, app, openAIRules);
    const owned = currentOwned;
    const owner = negotiateRetainedAppHost({
      ...owned,
      resolvers: {
        ...owned.resolvers,
        resolveEffectiveMcpAppsCapabilities: (args) => ({
          ...owned.resolvers.resolveEffectiveMcpAppsCapabilities(args),
          availableDisplayModes: modes.allowed,
          widgetDisplayModeRequests: "accept" as const,
        }),
      },
    });
    return { ...modes, owner };
  });
  const [appModes, setAppModes] = useState<
    ("inline" | "fullscreen" | "pip")[] | undefined
  >();
  const currentModes = settingsAppModes(host, app, openAIRules);
  const allowed = opening.allowed.filter(
    (value) =>
      currentModes.allowed.includes(value) &&
      (!appModes || appModes.includes(value)),
  );
  const allowedKey = allowed.join(",");
  const [requestedMode, setMode] = useState<SettingsDisplayMode>(
    opening.initial ?? "inline",
  );
  const mode = allowed.includes(requestedMode)
    ? requestedMode
    : (allowed.find((value) => value === currentModes.initial) ??
      allowed[0] ??
      "inline");
  // A refused initialized guest cannot be silently recreated if the profile changes back.
  const [invalidated, setInvalidated] = useState(!opening.initial);
  useLayoutEffect(() => {
    if (!allowed.length) setInvalidated(true);
  }, [allowedKey]);
  const valid = !invalidated && allowed.length > 0;
  const owner = useMemo(
    () =>
      withCurrentHostContext(opening.owner, {
        ...currentOwned,
        environment: {
          ...currentOwned.environment,
          draftHostContext: {
            ...currentOwned.environment.draftHostContext,
            displayMode: mode,
            availableDisplayModes: allowed,
          },
        },
      }),
    [opening.owner, currentOwned, mode, allowedKey],
  );
  const live = useRef(true),
    close = useRef(onClose),
    permitted = useRef(valid);
  close.current = onClose;
  permitted.current = valid;
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const dismiss = useCallback(() => {
    if (live.current) close.current();
  }, []);
  const changeMode = useCallback(
    (next: string) => {
      if (
        live.current &&
        permitted.current &&
        allowed.some((value) => value === next) &&
        isMode(next)
      )
        setMode(next);
    },
    [allowedKey],
  );
  const [invocation] = useState(() => ({ call: app.call, signal }));
  const callTool = useCallback<
    NonNullable<ComponentProps<typeof MCPAppsRendererSurface>["onCallTool"]>
  >(
    async (name, args, context) => {
      if (!live.current || !permitted.current)
        throw new DOMException("Settings App closed", "AbortError");
      return invocation.call(
        name,
        args,
        context
          ? AbortSignal.any([invocation.signal, context.signal])
          : invocation.signal,
        context?.onInputPending,
      );
    },
    [invocation],
  );
  const claim = dialog?.claim,
    release = dialog?.release;
  const forms = useComposerForms(scope.pluginWorkspace.workspaceId);
  const hasPendingForm = forms.length > 0;
  useLayoutEffect(() => {
    if (!claim || !release || !valid) return;
    claim(app.childToken, mode, dismiss, hasPendingForm);
    return () => release(app.childToken);
  }, [claim, release, app.childToken, mode, dismiss, valid, hasPendingForm]);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(
    () =>
      !dialog && slot
        ? registerComposerSlot(scope.pluginWorkspace.workspaceId, slot)
        : undefined,
    [!!dialog, slot, scope.pluginWorkspace.workspaceId],
  );
  const returnFocus = useFormDialogFocus(
    app.childToken,
    scope.pluginWorkspace.workspaceId,
    false,
    () => !signal.aborted,
    returnFocusTo,
  );
  const restore = useRef(returnFocus);
  restore.current = returnFocus;
  useEffect(
    () => () => {
      if (dialog) queueMicrotask(() => restore.current());
    },
    [!!dialog],
  );
  const body = (
    <div
      data-plugin-private="settings"
      data-settings-app-mode={mode}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {serverName} settings App
        </h2>
        {valid && allowed.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              changeMode(mode === "inline" ? "fullscreen" : "inline")
            }
          >
            {mode === "inline" ? "Enter full screen" : "Exit full screen"}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
          Close App
        </Button>
      </div>
      {!dialog && <div ref={setSlot} data-testid="settings-app-form-slot" />}
      <div
        hidden={!dialog && forms.length > 0}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {!valid ? (
          <p role="alert" className="p-4 text-sm">
            This App has no display mode supported by this client. Close it and
            check the client’s display settings.
          </p>
        ) : (
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
              displayMode={mode}
              fullscreenWidgetId={mode === "fullscreen" ? app.childToken : null}
              onAppSupportedDisplayModesChange={setAppModes}
              onDisplayModeChange={changeMode}
              onRequestFullscreen={() => changeMode("fullscreen")}
              onExitFullscreen={() =>
                allowed.includes("inline") ? changeMode("inline") : dismiss()
              }
              onCallTool={callTool}
            />
          </WidgetHostProvider>
        )}
      </div>
    </div>
  );
  if (dialog) return body;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        style={
          mode === "fullscreen"
            ? SETTINGS_FULLSCREEN_STYLE
            : { height: "85dvh" }
        }
        className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-3xl"
        showCloseButton={false}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={(event) => {
          if (forms.length) event.preventDefault();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{serverName} settings App</DialogTitle>
          <DialogDescription>
            Adjust settings in the App, then close it to return.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
