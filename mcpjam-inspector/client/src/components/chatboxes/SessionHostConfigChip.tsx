import { useMemo, useState } from "react";
import { Box, Server } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { useSessionHistoricalHostConfig } from "@/hooks/useSharedChatThreads";

interface SessionHostConfigChipProps {
  sessionId: string;
}

/**
 * Audit-trail chip rendered on each chatbox session row. Surfaces the
 * historical hostConfig the session was opened against — the row is
 * pinned in `chatSessions.hostConfigIdAtStart` at session-open time, so
 * even after the chatbox's referenced host has rotated forward we can
 * still tell the user which config this conversation actually ran on.
 *
 * Collapsed state shows model + server count. Expanded popover surfaces
 * the system prompt + temperature + requireToolApproval for the
 * historical config, plus a banner when the host's *current* config
 * differs from the historical pin.
 */
export function SessionHostConfigChip({ sessionId }: SessionHostConfigChipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { config } = useSessionHistoricalHostConfig({ sessionId });

  // Don't render anything for sessions that predate the audit pin —
  // there's nothing useful to show, and a "no data" chip is noisy.
  if (!config) return null;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <Box className="size-3" />
          <span className="font-medium">{config.modelId || "—"}</span>
          <span className="text-muted-foreground/70">·</span>
          <Server className="size-3" />
          <span>{config.serverCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start" side="bottom">
        <HistoricalConfigDetails config={config} />
      </PopoverContent>
    </Popover>
  );
}

function HistoricalConfigDetails({
  config,
}: {
  config: NonNullable<
    ReturnType<typeof useSessionHistoricalHostConfig>["config"]
  >;
}) {
  const truncatedPrompt = useMemo(() => {
    const trimmed = config.systemPrompt.trim();
    if (trimmed.length <= 240) return trimmed;
    return `${trimmed.slice(0, 240)}…`;
  }, [config.systemPrompt]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium text-foreground">
          Configuration this session ran on
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Pinned at session open. The current host may have changed since.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Detail label="Model" value={config.modelId || "—"} />
        <Detail label="Style" value={config.hostStyle} />
        <Detail label="Temperature" value={config.temperature.toFixed(2)} />
        <Detail
          label="Tool approval"
          value={config.requireToolApproval ? "Required" : "Off"}
        />
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Servers
        </p>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="text-[10px]">
            {config.serverIds.length} required
          </Badge>
          {config.optionalServerIds.length > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {config.optionalServerIds.length} optional
            </Badge>
          )}
        </div>
      </div>

      {truncatedPrompt && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            System prompt
          </p>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-foreground">
            {truncatedPrompt}
          </pre>
        </div>
      )}

      {config.currentHostName && (
        <p className="text-[11px] text-muted-foreground">
          Chatbox currently points at{" "}
          <span className="font-medium text-foreground">
            {config.currentHostName}
          </span>
          .
        </p>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-foreground">{value}</p>
    </div>
  );
}
