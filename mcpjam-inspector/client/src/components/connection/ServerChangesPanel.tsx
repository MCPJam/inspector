/**
 * "Changes since last successful connect" panel rendered at the top
 * of the server detail modal Overview tab.
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import type {
  ServerInspectionDiff,
  ToolChange,
  InitChange,
} from "@/lib/inspection/types";

interface ServerChangesPanelProps {
  diff: ServerInspectionDiff | null | undefined;
}

export function ServerChangesPanel({ diff }: ServerChangesPanelProps) {
  if (!diff) return null;

  const hasInitChanges = diff.initChanges.length > 0;
  const added = diff.toolChanges.filter((c) => c.type === "added");
  const removed = diff.toolChanges.filter((c) => c.type === "removed");
  const changed = diff.toolChanges.filter((c) => c.type === "changed");
  const hasToolChanges = added.length + removed.length + changed.length > 0;

  if (!hasInitChanges && !hasToolChanges) return null;

  return (
    <div
      data-testid="server-changes-panel"
      className="rounded-md border border-border/50 bg-muted/20 p-3 space-y-3 mb-4"
    >
      <div className="text-sm font-medium text-muted-foreground">
        Changes since last connect
      </div>

      {/* Summary badges */}
      <div className="flex flex-wrap gap-1.5">
        {added.length > 0 && (
          <Badge
            data-testid="badge-added"
            className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
          >
            <Plus className="h-3 w-3" />
            {added.length} added
          </Badge>
        )}
        {removed.length > 0 && (
          <Badge
            data-testid="badge-removed"
            className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
          >
            <Minus className="h-3 w-3" />
            {removed.length} removed
          </Badge>
        )}
        {changed.length > 0 && (
          <Badge
            data-testid="badge-changed"
            className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
          >
            <RefreshCw className="h-3 w-3" />
            {changed.length} changed
          </Badge>
        )}
        {hasInitChanges && (
          <Badge
            data-testid="badge-init"
            className="bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30"
          >
            Init changed
          </Badge>
        )}
      </div>

      {/* Init changes section */}
      {hasInitChanges && (
        <CollapsibleSection title="Initialization Changes" defaultOpen>
          <div className="space-y-2">
            {diff.initChanges.map((change) => (
              <InitChangeRow key={change.field} change={change} />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Tool changes section */}
      {hasToolChanges && (
        <CollapsibleSection title="Tool Changes" defaultOpen>
          <div className="space-y-3">
            {added.length > 0 && (
              <ToolChangeGroup label="Added" changes={added} />
            )}
            {removed.length > 0 && (
              <ToolChangeGroup label="Removed" changes={removed} />
            )}
            {changed.length > 0 && (
              <ToolChangeGroup label="Changed" changes={changed} />
            )}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer w-full">
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function InitChangeRow({ change }: { change: InitChange }) {
  const isObject =
    typeof change.before === "object" || typeof change.after === "object";

  return (
    <div
      data-testid={`init-change-${change.field}`}
      className="text-xs space-y-1"
    >
      <div className="font-medium text-muted-foreground capitalize">
        {formatFieldLabel(change.field)}
      </div>
      {isObject ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-muted-foreground/70 mb-0.5">
              Before
            </div>
            <ScrollableJsonView
              value={change.before ?? null}
              showLineNumbers={false}
              containerClassName="max-h-48 rounded"
            />
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground/70 mb-0.5">
              After
            </div>
            <ScrollableJsonView
              value={change.after ?? null}
              showLineNumbers={false}
              containerClassName="max-h-48 rounded"
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 font-mono">
          <span className="text-red-500/80 line-through">
            {String(change.before ?? "(none)")}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="text-emerald-500">
            {String(change.after ?? "(none)")}
          </span>
        </div>
      )}
    </div>
  );
}

function ToolChangeGroup({
  label,
  changes,
}: {
  label: string;
  changes: ToolChange[];
}) {
  return (
    <div data-testid={`tool-group-${label.toLowerCase()}`}>
      <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="space-y-1.5">
        {changes.map((change) => (
          <ToolChangeCard key={change.name} change={change} />
        ))}
      </div>
    </div>
  );
}

function ToolChangeCard({ change }: { change: ToolChange }) {
  const [expanded, setExpanded] = useState(false);

  if (change.type === "added") {
    return (
      <div className="rounded bg-emerald-500/5 border border-emerald-500/20 px-2.5 py-1.5 text-xs">
        <span className="font-mono font-medium">{change.name}</span>
        {change.after?.description && (
          <span className="text-muted-foreground ml-2">
            — {change.after.description}
          </span>
        )}
      </div>
    );
  }

  if (change.type === "removed") {
    return (
      <div className="rounded bg-red-500/5 border border-red-500/20 px-2.5 py-1.5 text-xs">
        <span className="font-mono font-medium line-through text-muted-foreground">
          {change.name}
        </span>
      </div>
    );
  }

  // Changed
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="rounded bg-amber-500/5 border border-amber-500/20 px-2.5 py-1.5 text-xs">
        <CollapsibleTrigger className="flex items-center gap-1.5 w-full cursor-pointer">
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="font-mono font-medium">{change.name}</span>
          <div className="flex gap-1 ml-auto">
            {change.changedFields?.map((field) => (
              <Badge
                key={field}
                variant="outline"
                className="text-[10px] px-1.5 py-0"
              >
                {field}
              </Badge>
            ))}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2">
          {change.changedFields?.map((field) => (
            <div key={field} className="space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground/70">
                {field}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-muted-foreground/70 mb-0.5">
                    Before
                  </div>
                  <ScrollableJsonView
                    value={
                      change.before?.[field as keyof typeof change.before] ??
                      null
                    }
                    showLineNumbers={false}
                    containerClassName="max-h-32 rounded"
                  />
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground/70 mb-0.5">
                    After
                  </div>
                  <ScrollableJsonView
                    value={
                      change.after?.[field as keyof typeof change.after] ?? null
                    }
                    showLineNumbers={false}
                    containerClassName="max-h-32 rounded"
                  />
                </div>
              </div>
            </div>
          ))}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function formatFieldLabel(field: string): string {
  switch (field) {
    case "protocolVersion":
      return "Protocol Version";
    case "transport":
      return "Transport";
    case "serverVersion":
      return "Server Version";
    case "instructions":
      return "Instructions";
    case "serverCapabilities":
      return "Server Capabilities";
    default:
      return field;
  }
}
