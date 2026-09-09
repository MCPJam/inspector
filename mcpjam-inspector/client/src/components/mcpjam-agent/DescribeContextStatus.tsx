import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import {
  getEvalDraft,
  readEvalContext,
  useEvalContextVersion,
} from "@/lib/mcpjam-agent/eval-workspace";

/** Recovery lives beside the composer, not inside the model's conversation. */
export function DescribeContextStatus({ scope }: { scope: EvalAgentScope }) {
  useEvalContextVersion((s) => s.version);
  const context = readEvalContext(scope);
  const [retrying, setRetrying] = useState<string>();
  const [error, setError] = useState<string>();
  const servers = context.case?.metadata?.servers ?? [];
  const ready = servers.filter(
    (s) => s.status === "ready" || s.status === "empty",
  ).length;
  if (context.status === "ready") return null;
  return (
    <div className="px-4 py-2 text-xs text-muted-foreground">
      <p role="status">
        {context.status === "empty"
          ? servers.length
            ? "These servers have no tools available. Refresh tools or check the suite’s connections."
            : "Choose a server in the suite to describe a test."
          : context.status === "error"
          ? "Couldn’t load tools. Your description is kept here."
          : context.status === "partial"
          ? `${ready} of ${servers.length} servers ready. You can use the tools already loaded.`
          : "Loading tools… Your description will continue when tools are ready."}
      </p>
      {servers
        .filter((s) => s.status === "error" || s.status === "empty")
        .map((server) => (
          <Button
            key={server.serverId}
            variant="ghost"
            size="sm"
            disabled={Boolean(retrying)}
            onClick={async () => {
              setError(undefined);
              setRetrying(server.serverId);
              try {
                await getEvalDraft(scope).retryTools?.(server.serverId);
              } catch {
                setError(
                  `Could not ${
                    server.action === "reconnect"
                      ? "reconnect"
                      : "refresh tools"
                  }. Check the server connection and try again.`,
                );
              } finally {
                setRetrying(undefined);
              }
            }}
          >
            {retrying === server.serverId
              ? "Connecting…"
              : `${server.action === "reconnect" ? "Reconnect" : "Retry"} ${
                  server.serverId
                }`}
          </Button>
        ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
