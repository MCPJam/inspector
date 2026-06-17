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
}

export function PinnedToolCallFields({
  seedKey,
  value,
  onChange,
  suiteServers,
  availableTools,
  projectServers,
}: PinnedToolCallFieldsProps) {
  const [serverName, setServerName] = useState(
    value?.serverName ?? suiteServers[0] ?? "",
  );
  const [toolName, setToolName] = useState(seedToolName(value?.toolName));
  const [argsJson, setArgsJson] = useState(() =>
    JSON.stringify(value?.arguments ?? {}, null, 2),
  );
  const [renderTimeoutMs, setRenderTimeoutMs] = useState<number | undefined>(
    value?.renderTimeoutMs,
  );
  const timeoutId = useId();

  // Re-seed only when the identity changes — NOT on every `value` update, so
  // the onChange→parent→value round-trip can't clobber in-progress typing.
  useEffect(() => {
    setServerName(value?.serverName ?? suiteServers[0] ?? "");
    setToolName(seedToolName(value?.toolName));
    setArgsJson(JSON.stringify(value?.arguments ?? {}, null, 2));
    setRenderTimeoutMs(value?.renderTimeoutMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const resolvedServerId = useMemo(
    () => (projectServers ?? []).find((s) => s.name === serverName)?._id,
    [projectServers, serverName],
  );

  const toolNames = useMemo(() => {
    const names = availableTools
      .filter(
        (t) =>
          !t.serverId || !resolvedServerId || t.serverId === resolvedServerId,
      )
      .map((t) => t.name);
    return Array.from(new Set(names));
  }, [availableTools, resolvedServerId]);

  const parsedArgs = useMemo(() => {
    try {
      const parsed = JSON.parse(argsJson || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Server</Label>
          {suiteServers.length > 0 ? (
            <Select value={serverName || undefined} onValueChange={setServerName}>
              <SelectTrigger className="h-8 text-xs">
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
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="Server name"
              className="h-8 text-xs"
            />
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Tool</Label>
          {toolNames.length > 0 ? (
            <Select value={toolName || undefined} onValueChange={setToolName}>
              <SelectTrigger className="h-8 text-xs">
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
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="e.g. show_map"
              className="h-8 text-xs"
            />
          )}
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">Arguments (JSON)</Label>
        <textarea
          className={`min-h-[88px] w-full rounded-md border bg-background p-2 font-mono text-[11px] leading-tight ${
            "error" in parsedArgs ? "border-red-500/60" : "border-border/60"
          }`}
          value={argsJson}
          onChange={(e) => setArgsJson(e.target.value)}
          spellCheck={false}
          aria-label="Arguments (JSON)"
        />
        {"error" in parsedArgs ? (
          <div className="text-[11px] text-red-600 dark:text-red-400">
            {parsedArgs.error}
          </div>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor={timeoutId} className="text-[11px]">
          Render timeout ms (optional)
        </Label>
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
          placeholder="Harness default"
          className="h-8 w-36 text-xs"
        />
      </div>
    </div>
  );
}
