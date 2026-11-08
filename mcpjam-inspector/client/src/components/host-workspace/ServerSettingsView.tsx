import type { ExtensionLaunchProfile, ExtensionLaunchObservation } from "@/lib/extension-launch-health";
import { useExtensionLaunchHealth } from "@/lib/use-extension-launch-health";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { Button } from "@mcpjam/design-system/button";
import { NativeSettingsEditor } from "../plugin-workspace/NativeSettingsEditor";
import type { WidgetHost } from "@mcpjam/widget-react";
import { SettingsApp } from "./SettingsApp";
import {
  createServerSettingsApi,
  type ServerSettingsSession,
  type ServerSettingsApp,
} from "./server-settings-api";
import type { ApproveAppTool, ThreadAppScope } from "./thread-app-api";
import {
  describePluginSettingsError,
  pluginSettingsErrorCode,
  settingsToolReplyText,
} from "./plugin-settings-errors";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";

/** The same private settings view belongs in Connect details and the workspace panel. */
export function ServerSettingsView({
  scope,
  serverId,
  serverName,
  approve,
  host,
  launchProfile = "chatgpt",
  launchObservation,
  onAppActiveChange,
}: {
  scope: ThreadAppScope;
  serverId: string;
  serverName: string;
  approve: ApproveAppTool;
  host?: WidgetHost;
  launchProfile?: ExtensionLaunchProfile;
  launchObservation?: ExtensionLaunchObservation;
  onAppActiveChange?: (active: boolean) => void;
}) {
  const launchOwner = JSON.stringify([
    scope.projectId,
    scope.hostId,
    scope.pluginWorkspace.workspaceId,
    serverId,
  ]);
  const launchHealth = useExtensionLaunchHealth(launchOwner);
  const launch =
    launchObservation ??
    launchHealth.begin("settings", "settings", launchProfile);
  const approveRef = useRef(approve);
  approveRef.current = approve;
  const [app, setApp] = useState<{
    value: ServerSettingsApp;
    name: string;
    opener: HTMLButtonElement;
  }>();
  useLayoutEffect(() => {
    onAppActiveChange?.(!!app);
    return () => onAppActiveChange?.(false);
  }, [app?.value.childToken, onAppActiveChange]);
  const appRef = useRef<ServerSettingsApp | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [session, setSession] = useState<ServerSettingsSession>();
  /** Open failure: `true` with no code, or the server's settings code. */
  const [error, setError] = useState<false | { code?: string }>(false);
  const reportFailure = (code: string | undefined, step: string) => {
    logPluginExtensionIssue({
      code: code ?? "PLUGIN_SETTINGS_FAILED",
      message: `${serverName} settings: ${describePluginSettingsError(code)}`,
      serverId,
      serverName,
      detail: { step },
      dedupeKey: `settings:${serverId}:${step}:${code ?? "unknown"}`,
    });
  };
  const reportFailureRef = useRef(reportFailure);
  reportFailureRef.current = reportFailure;
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<string>();
  const [result, setResult] = useState<{
    tool: string;
    text: string;
    failed: boolean;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    let current: ServerSettingsSession | undefined;
    setSession(undefined);
    setApp(undefined);
    setError(false);
    setResult(undefined);
    setPending(undefined);
    void createServerSettingsApi(scope, serverId, (...args) =>
      approveRef.current(...args),
    )
      .open(abort.signal)
      .then((value) => {
        current = value;
        if (abort.signal.aborted) {
          void value.close().catch(() => {});
          return;
        }
        setSession(value);
      })
      .catch((cause) => {
        if (abort.signal.aborted) return;
        const code = pluginSettingsErrorCode(cause);
        if (code === "APPROVAL_DENIED" || code === "PLUGIN_EXTENSION_DISABLED")
          launch.exclude();
        else launch.fail("execution");
        setError({ code });
        reportFailureRef.current(code, "open");
      });
    return () => {
      abort.abort();
      if (appRef.current) {
        void appRef.current.close().catch(() => {});
        appRef.current = undefined;
      }
      if (current) void current.close().catch(() => {});
    };
  }, [
    scope.projectId,
    scope.hostId,
    scope.pluginWorkspace.workspaceId,
    serverId,
    attempt,
  ]);
  useEffect(() => {
    if (session) launch.ready();
  }, [session, launch]);
  return (
    <section
      data-plugin-private="settings"
      aria-label={`${serverName} settings`}
      className={
        app
          ? "flex h-full min-h-0 flex-col overflow-hidden"
          : "min-h-0 space-y-4 overflow-auto p-4"
      }
      data-settings-layout
    >
      <h2 hidden={!!app} className="text-sm font-medium">
        {serverName} settings
      </h2>
      <div hidden={!!app}>
        {error ? (
          <div role="alert" className="space-y-2">
            <p>Settings could not be loaded.</p>
            <p className="text-sm text-muted-foreground">
              {describePluginSettingsError(error.code)}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        ) : !session ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading settings…
          </p>
        ) : (
          <NativeSettingsEditor
            controller={session.controller}
            actions={session.actions}
            actionPending={pending}
            actionResult={result}
            appActionsAvailable={!!host}
            onAction={(name, opener) => {
              if (pending) return;
              setPending(name);
              setResult(undefined);
              const owner = lifetime.current!;
              const active = owner.signal;
              if (
                session.actions.some(
                  (action) => action.name === name && action.kind === "app",
                )
              ) {
                if (appRef.current) void appRef.current.close().catch(() => {});
                setApp(undefined);
                void session
                  .openApp(name, active)
                  .then((value) => {
                    if (active.aborted) {
                      void value.close().catch(() => {});
                      return;
                    }
                    appRef.current = value;
                    setApp({ value, name, opener });
                  })
                  .catch((cause) => {
                    if (owner.signal.aborted) return;
                    const code = pluginSettingsErrorCode(cause);
                    setResult({
                      tool: name,
                      text: code
                        ? `App could not be opened. ${describePluginSettingsError(code)}`
                        : "App could not be opened.",
                      failed: true,
                    });
                    reportFailureRef.current(code, `app:${name}`);
                  })
                  .finally(() => {
                    if (!owner.signal.aborted) setPending(undefined);
                  });
              } else
                void session
                  .action(name, active)
                  .then((reply) => {
                    if (owner.signal.aborted) return;
                    // The spec shows the tool's own reply, not a fixed label.
                    const text = settingsToolReplyText(reply);
                    const failed = reply?.isError === true;
                    setResult({
                      tool: name,
                      text:
                        text ||
                        (failed ? "The action reported an error." : "Done"),
                      failed,
                    });
                  })
                  .catch((cause) => {
                    if (owner.signal.aborted) return;
                    const code = pluginSettingsErrorCode(cause);
                    setResult({
                      tool: name,
                      text: code
                        ? `Action could not be completed. ${describePluginSettingsError(code)}`
                        : "Action could not be completed.",
                      failed: true,
                    });
                    reportFailureRef.current(code, `action:${name}`);
                  })
                  .finally(() => {
                    if (!owner.signal.aborted) setPending(undefined);
                  });
            }}
          />
        )}
      </div>
      {app && host && (
        <SettingsApp
          key={app.value.childToken}
          app={app.value}
          toolName={app.name}
          returnFocusTo={app.opener}
          host={host}
          serverId={serverId}
          serverName={serverName}
          scope={scope}
          signal={lifetime.current!.signal}
          onClose={() => {
            void app.value.close().catch(() => {});
            appRef.current = undefined;
            setApp(undefined);
          }}
        />
      )}
    </section>
  );
}
