import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { usePlaygroundChatHistoryBridge } from "@/components/playground/playground-chat-history-bridge";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { useBrowserReadinessStore } from "@/stores/browser-readiness-store";

export function BrowserRuntimeControls({
  projectId,
}: {
  projectId: string | null;
}) {
  const engine = useBrowserEngine(projectId);
  const bridge = usePlaygroundChatHistoryBridge();
  const sessionId = useActiveChatSessionStore((s) => s.sessionId);
  const reason = useBrowserReadinessStore(
    (s) => s.reasons[`${projectId}:${sessionId}`],
  );
  const [pending, setPending] = useState<"local" | "cloud" | null>(null);
  const [starting, setStarting] = useState(false);
  const choose = (location: "local" | "cloud") => {
    if (location === engine.selectedEngine) return;
    if (sessionId) setPending(location);
    else engine.setEngine(location);
  };
  const startNew = async () => {
    if (!pending || !bridge || bridge.isStreaming) return;
    setStarting(true);
    try {
      const started = await bridge.onNewChat();
      if (started === true) {
        engine.setEngine(pending);
        setPending(null);
      }
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 border-b border-border p-2 text-xs">
      <div className="flex items-center gap-2">
        {engine.toggleVisible ? (
          <select
            aria-label="Browser location"
            className="rounded border border-border bg-background p-1"
            value={engine.selectedEngine}
            onChange={(e) => choose(e.target.value as "local" | "cloud")}
          >
            <option value="local">This machine</option>
            <option value="cloud">Cloud</option>
          </select>
        ) : (
          <span>Cloud</span>
        )}
        <span className="text-muted-foreground">
          {!engine.resolved
            ? "Checking Browser…"
            : engine.selectedEngine === "local"
            ? !engine.localAvailable
              ? "Browser unavailable on this machine"
              : engine.consent.granted
              ? "Browser authorized"
              : "Browser permission required"
            : engine.cloudAvailable
            ? "Cloud Browser"
            : "Cloud Browser unavailable"}
        </span>
        {engine.selectedEngine === "local" && engine.consent.granted ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void engine.consent.revoke()}
          >
            Revoke Browser
          </Button>
        ) : null}
      </div>
      {pending ? (
        <div role="status">
          Changing Browser location starts a new chat. Tabs and logins stay
          here.
          <Button
            size="sm"
            disabled={!bridge || bridge.isStreaming || starting}
            onClick={() => void startNew()}
          >
            Start new chat
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {reason ? (
        <p role="status" className="text-muted-foreground">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
