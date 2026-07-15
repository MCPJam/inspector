/**
 * Compact read-back card for a pinned (model-free) "render check" turn.
 *
 * Replaces the always-open Server / Tool / Arguments-JSON form. A render check is
 * normally created by *pinning a tool call from a live run* (no hand-typing); this
 * card shows what was pinned (tool · server · arg count) and tucks the full
 * editable `PinnedToolCallFields` behind an "Edit" disclosure so existing/migrated
 * pinned cases stay fully editable without the redundant form dominating the UI.
 */
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { RemoteServer } from "@/hooks/useProjects";
import type { ProbeConfig } from "@/shared/probe-config";
import { PinnedToolCallFields } from "./pinned-tool-call-fields";

export function PinnedRenderCheckCard({
  seedKey,
  value,
  onChange,
  onClear,
  suiteServers,
  availableTools,
  projectServers,
}: {
  seedKey: string;
  value: ProbeConfig | undefined;
  onChange: (cfg: ProbeConfig) => void;
  onClear: () => void;
  suiteServers: string[];
  availableTools: Array<{ name: string; serverId?: string }>;
  projectServers?: RemoteServer[];
}) {
  // Open the editor immediately for a freshly-created (unfilled) render check;
  // collapse to read-back once a tool is chosen.
  const [editing, setEditing] = useState(!value?.toolName);
  const argCount = value?.arguments ? Object.keys(value.arguments).length : 0;

  return (
    <section className="space-y-2 rounded-md border border-border/60 bg-muted/10 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Tool call ·</span>
        <span className="font-mono text-[12px] text-foreground">
          {value?.toolName || "pick a tool"}
        </span>
        {value?.serverName ? (
          <span className="text-[11px] text-muted-foreground">
            on {value.serverName}
          </span>
        ) : null}
        {argCount > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            · {argCount} arg{argCount === 1 ? "" : "s"}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? "Done" : "Edit"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            onClick={onClear}
            aria-label="Remove render check"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {editing ? (
        <PinnedToolCallFields
          seedKey={seedKey}
          value={value}
          onChange={onChange}
          suiteServers={suiteServers}
          availableTools={availableTools}
          projectServers={projectServers}
        />
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        No model — this turn calls the tool and renders its widget.
      </p>
    </section>
  );
}
