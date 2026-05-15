import { useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";
import { Chip, FocusBlock } from "./primitives";

interface ServersTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  availableServers: ReadonlyArray<{
    id: string;
    name: string;
    url?: string | null;
  }>;
  /** Set when the user clicked a specific server card on the canvas. */
  initialSelectedServerId: string | null;
  onAddServer: () => void;
}

type Override = {
  headersOverride?: Record<string, string>;
  requestTimeoutOverride?: number;
};

export function ServersTab({
  draft,
  onDraftChange,
  availableServers,
  initialSelectedServerId,
  onAddServer,
}: ServersTabProps) {
  const [expandedServerId, setExpandedServerId] = useState<string | null>(
    initialSelectedServerId,
  );

  const overrides = draft.serverConnectionOverrides ?? {};

  const setOverride = (serverId: string, next: Override | null) => {
    onDraftChange((prev) => {
      const cur = { ...(prev.serverConnectionOverrides ?? {}) };
      if (next === null) {
        delete cur[serverId];
      } else {
        cur[serverId] = next;
      }
      return {
        ...prev,
        serverConnectionOverrides:
          Object.keys(cur).length === 0 ? undefined : cur,
      };
    });
  };

  // Every project server is implicitly attached to every host. The only
  // per-host decision is required vs not-required — `serverIds` is the
  // explicit "required" list; everything else is optional. `optionalServerIds`
  // is retired under this model; we always write `[]`.
  const setRequired = (serverId: string, checked: boolean) => {
    onDraftChange((prev) => {
      const required = checked
        ? Array.from(new Set([...prev.serverIds, serverId]))
        : prev.serverIds.filter((id) => id !== serverId);
      return {
        ...prev,
        serverIds: required,
        optionalServerIds: [],
      };
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock
        title="Attached servers"
        subtitle="Every project server attaches to this host. Mark the ones the host depends on as required — the rest are optional."
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={onAddServer}
          >
            <Plus className="size-3" />
            Add server
          </Button>
        }
      >
        {availableServers.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No servers in this project yet — add one to start configuring.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {availableServers.map((srv) => {
              const isRequired = draft.serverIds.includes(srv.id);
              const isOptional = !isRequired;
              const override = overrides[srv.id];
              const expanded = expandedServerId === srv.id;
              const overrideCount =
                (override?.headersOverride &&
                Object.keys(override.headersOverride).length > 0
                  ? 1
                  : 0) +
                (override?.requestTimeoutOverride !== undefined ? 1 : 0);

              return (
                <div
                  key={srv.id}
                  className={cn(
                    "rounded-md border bg-card/60",
                    expanded ? "border-border" : "border-border/60",
                  )}
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Checkbox
                      checked={isRequired}
                      onCheckedChange={(c) => setRequired(srv.id, !!c)}
                      aria-label={`Required: ${srv.name}`}
                    />
                    <span
                      className="flex size-1.5 shrink-0 rounded-full bg-emerald-500"
                      aria-hidden
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span
                        className="truncate text-[12.5px] font-semibold"
                        title={srv.name}
                      >
                        {srv.name}
                      </span>
                      <span
                        className="truncate font-mono text-[10.5px] text-muted-foreground"
                        title={srv.url ?? "Project server"}
                      >
                        {srv.url ?? "Project server"}
                      </span>
                    </div>
                    <Chip
                      tone={isOptional ? "info" : "primary"}
                      mono={false}
                    >
                      {isOptional ? "optional" : "required"}
                    </Chip>
                    {overrideCount > 0 ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[9.5px] text-amber-800 dark:text-amber-300"
                      >
                        {overrideCount}{" "}
                        {overrideCount === 1 ? "override" : "overrides"}
                      </Badge>
                    ) : (
                      <span className="text-[10.5px] text-muted-foreground/70">
                        uses defaults
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground"
                      onClick={() =>
                        setExpandedServerId(expanded ? null : srv.id)
                      }
                      aria-label={expanded ? "Collapse" : "Expand"}
                    >
                      {expanded ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                    </Button>
                  </div>
                  {expanded ? (
                    <ServerOverrideEditor
                      override={override}
                      onChange={(next) => setOverride(srv.id, next)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </FocusBlock>
    </div>
  );
}

function ServerOverrideEditor({
  override,
  onChange,
}: {
  override: Override | undefined;
  onChange: (next: Override | null) => void;
}) {
  const hasOverride = override !== undefined;
  const headers = override?.headersOverride ?? {};
  const timeout = override?.requestTimeoutOverride;

  const [addingHeader, setAddingHeader] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");

  const writeHeaders = (next: Record<string, string>) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (k.trim() === "" || k.toLowerCase() === "authorization") continue;
      cleaned[k] = v;
    }
    const hasHeaders = Object.keys(cleaned).length > 0;
    const hasTimeout = timeout !== undefined;
    if (!hasHeaders && !hasTimeout) {
      onChange(null);
      return;
    }
    onChange({
      ...(hasHeaders ? { headersOverride: cleaned } : {}),
      ...(hasTimeout ? { requestTimeoutOverride: timeout } : {}),
    });
  };

  return (
    <div className="border-t border-border/50 px-3 py-3">
      <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium">Overrides</span>
            <div className="flex items-center gap-1.5">
              <Switch
                checked={hasOverride}
                onCheckedChange={(c) =>
                  onChange(c ? { headersOverride: {} } : null)
                }
                aria-label="Enable overrides"
              />
              <span className="text-[11px] text-muted-foreground">
                {hasOverride ? "active" : "uses host defaults"}
              </span>
            </div>
          </div>

          {hasOverride ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium">
                  Timeout override
                </span>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    step={500}
                    value={timeout ?? ""}
                    placeholder="(host default)"
                    onChange={(e) => {
                      const v = e.target.value;
                      const parsed = v === "" ? undefined : Number(v);
                      const nextTimeout =
                        parsed === undefined || !Number.isFinite(parsed)
                          ? undefined
                          : parsed;
                      const hasHeaders =
                        Object.keys(headers).length > 0;
                      if (nextTimeout === undefined && !hasHeaders) {
                        onChange(null);
                        return;
                      }
                      onChange({
                        ...(hasHeaders
                          ? { headersOverride: headers }
                          : {}),
                        ...(nextTimeout !== undefined
                          ? { requestTimeoutOverride: nextTimeout }
                          : {}),
                      });
                    }}
                    className="h-8 w-32 font-mono text-[11px]"
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    ms
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium">Headers</span>
                {Object.keys(headers).length === 0 && !addingHeader ? (
                  <p className="text-[11px] text-muted-foreground">
                    None — host defaults will apply.
                  </p>
                ) : null}
                {Object.entries(headers).map(([key, val]) => (
                  <div key={key} className="flex items-center gap-2">
                    <Input
                      value={key}
                      disabled
                      className="h-7 w-40 font-mono text-[11px]"
                    />
                    <Input
                      value={val}
                      onChange={(e) => {
                        const next = { ...headers, [key]: e.target.value };
                        writeHeaders(next);
                      }}
                      className="h-7 flex-1 font-mono text-[11px]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...headers };
                        delete next[key];
                        writeHeaders(next);
                      }}
                      className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
                    >
                      remove
                    </button>
                  </div>
                ))}
                {addingHeader ? (
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus
                      placeholder="X-Header"
                      value={draftKey}
                      onChange={(e) => setDraftKey(e.target.value)}
                      className="h-7 w-40 font-mono text-[11px]"
                    />
                    <Input
                      placeholder="value"
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value)}
                      className="h-7 flex-1 font-mono text-[11px]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const k = draftKey.trim();
                        if (k === "" || k.toLowerCase() === "authorization")
                          return;
                        writeHeaders({ ...headers, [k]: draftValue });
                        setDraftKey("");
                        setDraftValue("");
                        setAddingHeader(false);
                      }}
                      className="text-[10.5px] underline-offset-2 hover:underline"
                    >
                      add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftKey("");
                        setDraftValue("");
                        setAddingHeader(false);
                      }}
                      className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
                    >
                      cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingHeader(true)}
                    className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed border-border/70 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                  >
                    + Add header
                  </button>
                )}
              </div>
            </>
          ) : null}
      </div>
    </div>
  );
}
