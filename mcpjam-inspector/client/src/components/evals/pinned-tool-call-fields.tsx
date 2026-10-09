/**
 * Server / Tool / Arguments / Render-timeout fields for a pinned (model-free)
 * tool call. Shared by the per-turn editor (a "Render check" turn in the
 * prompt flow) and the standalone render-check editor, so both author the same
 * `pinnedToolCall` shape.
 *
 * Self-contained local state: the JSON args textarea needs string state to
 * allow in-progress (temporarily invalid) edits. The component re-seeds when
 * `turnId` changes and reports the assembled config up via `onChange` (or
 * `null` while the JSON is unparseable), so the parent never has to manage the
 * raw string.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  type ProbeConfig,
  MAX_PROBE_RENDER_TIMEOUT_MS,
  PROBE_TOOL_NAME_PLACEHOLDER,
} from "@/shared/probe-config";
import type { RemoteServer } from "@/hooks/useProjects";

/** The create-flow placeholder reads as "unset". */
function seedToolName(persisted: string | undefined): string {
  return persisted === PROBE_TOOL_NAME_PLACEHOLDER ? "" : (persisted ?? "");
}

export interface PinnedToolCallFieldsProps {
  /** Re-seed local state when this changes (e.g. switching turns/cases). */
  seedKey: string;
  value: ProbeConfig | undefined;
  /**
   * The assembled config. Always an object (never null) so the owning turn
   * stays in render-check mode while incomplete — `toolName` may be empty
   * until picked, and `arguments` holds the last valid parse while the JSON
   * textarea is mid-edit. The save gate validates completeness separately.
   */
  onChange: (next: ProbeConfig) => void;
  suiteServers: string[];
  availableTools: Array<{ name: string; serverId?: string }>;
  projectServers?: RemoteServer[];
  /** Render the fields locked (snapshot view): selects disabled, inputs read-only. */
  readOnly?: boolean;
  paper?: boolean;
}

export function PinnedToolCallFields({
  seedKey,
  value,
  onChange,
  suiteServers,
  availableTools,
  projectServers,
  readOnly = false,
  paper = false,
}: PinnedToolCallFieldsProps) {
  const [serverName, setServerName] = useState(
    value?.serverName ?? suiteServers[0] ?? "",
  );
  const [toolName, setToolName] = useState(seedToolName(value?.toolName));
  const [argsJson, setArgsJson] = useState(() =>
    JSON.stringify(value?.arguments ?? {}, null, paper ? undefined : 2),
  );
  const [renderTimeoutMs, setRenderTimeoutMs] = useState<number | undefined>(
    value?.renderTimeoutMs,
  );
  const timeoutId = useId();
  const serverId = useId();
  const toolId = useId();
  const argsId = useId();

  // Re-seed only when the identity changes — NOT on every `value` update, so
  // the onChange→parent→value round-trip can't clobber in-progress typing.
  useEffect(() => {
    setServerName(value?.serverName ?? suiteServers[0] ?? "");
    setToolName(seedToolName(value?.toolName));
    setArgsJson(
      JSON.stringify(value?.arguments ?? {}, null, paper ? undefined : 2),
    );
    setRenderTimeoutMs(value?.renderTimeoutMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const resolvedServerId = useMemo(
    () => (projectServers ?? []).find((s) => s.name === serverName)?._id,
    [projectServers, serverName],
  );

  const toolNames = useMemo(() => {
    // A tool's `serverId` is the Convex `_id` in local mode but the server
    // *name* in hosted mode (see listEvalTools). Accept either so the filter
    // doesn't drop every tool when the id spaces differ.
    const acceptable = new Set(
      [resolvedServerId, serverName].filter(Boolean) as string[],
    );
    const names = availableTools
      .filter(
        (t) =>
          !t.serverId || acceptable.size === 0 || acceptable.has(t.serverId),
      )
      .map((t) => t.name);
    return Array.from(new Set(names));
  }, [availableTools, resolvedServerId, serverName]);

  const parsedArgs = useMemo(() => {
    try {
      const parsed = JSON.parse(argsJson || "{}");
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return { error: "Expected a JSON object" } as const;
      }
      return { value: parsed as Record<string, unknown> } as const;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid JSON",
      } as const;
    }
  }, [argsJson]);

  // Keep the last successfully-parsed args so a mid-edit invalid JSON string
  // doesn't wipe the persisted arguments object.
  const lastValidArgs = useRef<Record<string, unknown>>(value?.arguments ?? {});

  // Report the assembled config upward whenever an input changes. Always an
  // object so the turn stays pinned while incomplete.
  useEffect(() => {
    if ("value" in parsedArgs) {
      lastValidArgs.current = parsedArgs.value ?? {};
    }
    onChange({
      ...(resolvedServerId ? { serverId: resolvedServerId } : {}),
      serverName,
      toolName,
      arguments: lastValidArgs.current,
      ...(renderTimeoutMs ? { renderTimeoutMs } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName, toolName, argsJson, renderTimeoutMs, resolvedServerId]);

  return (
    <div className="space-y-3">
      <div className={paper ? "space-y-2" : "grid gap-3 sm:grid-cols-2"}>
        <div className="space-y-1">
          <Label
            htmlFor={serverId}
            className={paper ? "text-sm font-medium" : "text-[11px]"}
          >
            Server
          </Label>
          {suiteServers.length > 0 ? (
            <Select
              disabled={readOnly}
              value={serverName || undefined}
              onValueChange={(nextServer) => {
                // Switching servers invalidates a tool picked from the old
                // server — clear it so we never emit a server-B + tool-A pair.
                if (nextServer !== serverName) setToolName("");
                setServerName(nextServer);
              }}
            >
              <SelectTrigger
                id={serverId}
                className={paper ? "h-9 text-sm" : "h-8 text-xs"}
              >
                <SelectValue placeholder="Pick a server…" />
              </SelectTrigger>
              <SelectContent>
                {suiteServers.map((name) => (
                  <SelectItem key={name} value={name} className="text-xs">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={serverId}
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="Server name"
              readOnly={readOnly}
              className={paper ? "h-9 text-sm" : "h-8 text-xs"}
            />
          )}
        </div>
        <div className="space-y-1">
          <Label
            htmlFor={toolId}
            className={paper ? "text-sm font-medium" : "text-[11px]"}
          >
            Tool
          </Label>
          {toolNames.length > 0 ? (
            <Select
              disabled={readOnly}
              value={toolName || undefined}
              onValueChange={setToolName}
            >
              <SelectTrigger
                id={toolId}
                className={paper ? "h-9 text-sm" : "h-8 text-xs"}
              >
                <SelectValue placeholder="Pick a tool…" />
              </SelectTrigger>
              <SelectContent>
                {toolNames.map((name) => (
                  <SelectItem key={name} value={name} className="text-xs">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={toolId}
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="e.g. show_map"
              readOnly={readOnly}
              className={paper ? "h-9 text-sm" : "h-8 text-xs"}
            />
          )}
        </div>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor={argsId}
          className={paper ? "text-sm font-medium" : "text-[11px]"}
        >
          {paper ? "Arguments" : "Arguments (JSON)"}
        </Label>
        <textarea
          id={argsId}
          className={`${paper ? "h-9 min-h-9 resize-y px-3 py-2 font-sans text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30" : "min-h-[88px] p-2 font-mono text-[11px] leading-tight"} w-full rounded-md border ${paper ? "bg-card" : "bg-background"} ${
            "error" in parsedArgs
              ? "border-destructive/60"
              : paper
                ? "border-input"
                : "border-border/60"
          }`}
          rows={paper ? 1 : undefined}
          value={argsJson}
          onChange={(e) => setArgsJson(e.target.value)}
          spellCheck={false}
          readOnly={readOnly}
          aria-label={paper ? "Arguments" : "Arguments (JSON)"}
        />
        {"error" in parsedArgs ? (
          <div className="text-[11px] text-destructive">{parsedArgs.error}</div>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label
          htmlFor={timeoutId}
          className={paper ? "text-sm font-medium" : "text-[11px]"}
        >
          Render timeout ms (optional)
        </Label>
        <div
          className={
            paper
              ? "flex items-center gap-1.5 text-[13px] text-secondary-foreground"
              : undefined
          }
        >
          <Input
            id={timeoutId}
            type="number"
            min={1}
            max={MAX_PROBE_RENDER_TIMEOUT_MS}
            step={500}
            value={renderTimeoutMs ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                setRenderTimeoutMs(undefined);
                return;
              }
              const n = Number(raw);
              if (!Number.isFinite(n)) return;
              setRenderTimeoutMs(Math.floor(n));
            }}
            placeholder={paper ? undefined : "Harness default"}
            readOnly={readOnly}
            className={
              paper ? "h-6 w-16 px-2 text-xs md:text-xs" : "h-8 w-36 text-xs"
            }
          />
          {paper ? <span>ms</span> : null}
        </div>
      </div>
    </div>
  );
}
