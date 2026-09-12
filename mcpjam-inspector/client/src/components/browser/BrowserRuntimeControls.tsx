import { LocalBrowserConsentGate } from "./LocalBrowserConsentGate";
import { Settings2 } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@mcpjam/design-system/popover";
import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { usePlaygroundChatHistoryBridge } from "@/components/playground/playground-chat-history-bridge";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { useBrowserReadinessStore } from "@/stores/browser-readiness-store";
import { HOSTED_MODE } from "@/lib/config";

export function BrowserRuntimeControls({
  projectId,
  compact = false,
  settings = false,
}: {
  projectId: string | null;
  compact?: boolean;
  settings?: boolean;
}) {
  const engine = useBrowserEngine(
    projectId,
    settings ? "preference" : "conversation",
  );
  const bridge = usePlaygroundChatHistoryBridge();
  const activeSessionId = useActiveChatSessionStore((s) => s.sessionId);
  const sessionId = settings ? null : activeSessionId;
  const reason = useBrowserReadinessStore(
    (s) => s.reasons[`${projectId}:${sessionId}`],
  );
  const visibleReason = settings
    ? null
    : reason?.startsWith("browser_consent_required:")
    ? engine.consent.granted
      ? null
      : "Allow Browser below, then retry your request."
    : reason?.replace(/^browser_[a-z_]+:\s*/, "");
  const [pending, setPending] = useState<"local" | "cloud" | null>(null);
  const [starting, setStarting] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
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
  const controls = (
    <div className="flex flex-col gap-2 p-2 text-xs">
      {settings && engine.toggleVisible ? (
        <p className="text-muted-foreground">
          Location for new Playground chats. Existing chats keep their browser;
          environments use Cloud.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {engine.toggleVisible ? (
          <select
            aria-label="Browser location"
            className="rounded border border-border bg-background p-1"
            value={engine.selectedEngine}
            onChange={(e) => choose(e.target.value as "local" | "cloud")}
          >
            <option value="local" disabled={!engine.localAvailable}>
              This machine
            </option>
            <option value="cloud" disabled={!engine.cloudAvailable}>
              Cloud
            </option>
          </select>
        ) : engine.selectedEngine === "cloud" ? (
          <span>Cloud</span>
        ) : null}
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
      {!HOSTED_MODE &&
      engine.selectedEngine === "local" &&
      engine.localAvailable &&
      engine.consent.granted &&
      !showSetup ? (
        <Button variant="outline" size="sm" onClick={() => setShowSetup(true)}>
          Enable for all clients
        </Button>
      ) : null}
      {showSetup && engine.selectedEngine === "local" ? (
        <LocalBrowserConsentGate
          location="browser_settings"
          onAllow={async () => {
            const ok = await engine.consent.grant();
            if (ok) setShowSetup(false);
            return ok;
          }}
        />
      ) : null}
      {settings &&
      !showSetup &&
      engine.selectedEngine === "local" &&
      engine.localAvailable &&
      !engine.consent.granted ? (
        <LocalBrowserConsentGate
          location="browser_settings"
          onAllow={engine.consent.grant}
        />
      ) : null}
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
      {visibleReason ? (
        <p role="status" className="text-muted-foreground">
          {visibleReason}
        </p>
      ) : null}
    </div>
  );
  if (!compact) return controls;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Browser options"
          title={
            engine.toggleVisible
              ? "Browser location and permissions"
              : "Browser permissions"
          }
        >
          <Settings2 className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        {controls}
      </PopoverContent>
    </Popover>
  );
}
