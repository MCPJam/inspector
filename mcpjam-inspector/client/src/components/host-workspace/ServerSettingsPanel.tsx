import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useWidgetHost } from "../chat-v2/thread/mcp-apps/use-widget-host";
import { ServerSettingsView } from "./ServerSettingsView";
import type { ApproveAppTool, ThreadAppScope } from "./thread-app-api";

type Request = {
  value: Parameters<ApproveAppTool>[0];
  finish(allowed: boolean): void;
};
/** Shared Connect/workspace presentation; approval stays inline, never a nested dialog. */
export function ServerSettingsPanel({
  scope,
  serverId,
  serverName,
}: {
  scope: ThreadAppScope;
  serverId: string;
  serverName: string;
}) {
  const host = useWidgetHost();
  const [request, setRequest] = useState<Request | null>(null);
  const waiting = useRef(new Set<(allowed: boolean) => void>());
  const mounted = useRef(true);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      for (const finish of waiting.current) finish(false);
    };
  }, []);
  const approve = useCallback<ApproveAppTool>((value, signal) => {
    const admittedGeneration = generation.current;
    const answer = queue.current.then(
      () =>
        new Promise<boolean>((resolve) => {
          if (
            !mounted.current ||
            generation.current !== admittedGeneration ||
            signal.aborted
          )
            return resolve(false);
          let settled = false;
          const finish = (allowed: boolean) => {
            if (settled) return;
            settled = true;
            waiting.current.delete(finish);
            signal.removeEventListener("abort", abort);
            if (mounted.current) setRequest(null);
            resolve(allowed);
          };
          const abort = () => finish(false);
          waiting.current.add(finish);
          signal.addEventListener("abort", abort, { once: true });
          setRequest({ value, finish });
        }),
    );
    queue.current = answer.then(
      () => undefined,
      () => undefined,
    );
    return answer;
  }, []);
  return (
    <div className="min-h-0 overflow-auto" data-plugin-private="settings">
      {request && (
        <section
          role="alert"
          aria-label="Approve settings action"
          className="space-y-3 border-b border-border p-4"
        >
          <p className="text-sm font-medium">Allow {request.value.name}?</p>
          <p className="text-sm text-muted-foreground">{serverName}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(request.value.params ?? {}, null, 2)}
          </pre>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => request.finish(false)}
            >
              Deny
            </Button>
            <Button type="button" onClick={() => request.finish(true)}>
              Allow
            </Button>
          </div>
        </section>
      )}
      <ServerSettingsView
        scope={scope}
        serverId={serverId}
        serverName={serverName}
        approve={approve}
        host={host}
      />
    </div>
  );
}
