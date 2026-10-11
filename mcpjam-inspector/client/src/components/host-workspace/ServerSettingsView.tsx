import { useEffect, useState, useRef } from "react";
import { Button } from "@mcpjam/design-system/button";
import { NativeSettingsEditor } from "../plugin-workspace/NativeSettingsEditor";
import type { WidgetHost } from "@mcpjam/widget-react";
import { SettingsInlineApp } from "./SettingsInlineApp";
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
}: {
  scope: ThreadAppScope;
  serverId: string;
  serverName: string;
  approve: ApproveAppTool;
  host?: WidgetHost;
}) {
  const approveRef = useRef(approve);
  approveRef.current = approve;
  const [app, setApp] = useState<{ value: ServerSettingsApp; name: string }>();
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
  return (
    <section
      data-plugin-private="settings"
      aria-label={`${serverName} settings`}
      className="min-h-0 space-y-4 overflow-auto p-4"
    >
      <h2 className="text-sm font-medium">{serverName} settings</h2>
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
          onAction={(name) => {
            if (pending) return;
            setPending(name);
            setResult(undefined);
            const owner = lifetime.current!;
            const active = AbortSignal.any([
              owner.signal,
              AbortSignal.timeout(60000),
            ]);
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
                  setApp({ value, name });
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
                    text: text || (failed ? "The action reported an error." : "Done"),
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
      {app && host && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void app.value.close().catch(() => {});
              appRef.current = undefined;
              setApp(undefined);
            }}
          >
            Close App
          </Button>
          <SettingsInlineApp
            app={app.value}
            toolName={app.name}
            host={host}
            serverId={serverId}
            serverName={serverName}
            signal={lifetime.current!.signal}
          />
        </div>
      )}
    </section>
  );
}
