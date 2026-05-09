/**
 * Shared HostConfigEditor.
 *
 * Used by:
 *  - Project Settings → edits projects.defaultHostConfigId. Copy makes
 *    clear that this seeds new chatboxes, eval suites, and direct chat
 *    tabs only — editing it does NOT propagate to existing children.
 *  - Chatbox Editor / Builder → edits the chatbox-owned hostConfigId.
 *  - Eval Suite Settings → edits the suite-owned hostConfigId.
 *  - Connection Settings (legacy) → edits the project default's connection
 *    portion only via a compat wrapper. That tab continues to render its
 *    own connection-only UI rather than embedding this whole editor.
 *
 * Phase 1: this is a controlled component that reflects a v2 input value
 * and emits changes. Concrete editors wire it up to the relevant Convex
 * mutation. The fancier sub-controls (server picker, capability JSON
 * editor) are imported from existing components in subsequent PRs; for
 * Phase 1 we expose minimal text/number/JSON inputs so the shape is
 * fully editable end-to-end.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Switch } from "@mcpjam/design-system/switch";
import { Slider } from "@mcpjam/design-system/slider";
import { Separator } from "@mcpjam/design-system/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  type HostConfigInputV2,
  type HostStyleId,
  DEFAULT_TEMPERATURE_V2,
} from "@/lib/host-config-v2";
import { listHostStyles } from "@/lib/host-styles";

export type HostConfigEditorOwner =
  | "project-default"
  | "chatbox"
  | "eval-suite"
  | "connection-only";

export interface HostConfigEditorProps {
  value: HostConfigInputV2;
  onChange: (next: HostConfigInputV2) => void;
  /**
   * Disable subsections that don't apply to a given owner. For example
   * Connection Settings only edits the connection portion.
   */
  owner?: HostConfigEditorOwner;
  /**
   * Pool of project servers the user may select. Each entry is `{ id, name }`.
   * Server selection UI is rendered as a simple multi-checkbox list for
   * Phase 1. The full builder picker is wired in later phases.
   */
  availableServers?: ReadonlyArray<{ id: string; name: string }>;
  /** Show a one-line caption above the editor (e.g. seed-only copy). */
  caption?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
}

export function HostConfigEditor({
  value,
  onChange,
  owner = "chatbox",
  availableServers,
  caption,
  className,
}: HostConfigEditorProps) {
  const reactId = useId();

  const update = useCallback(
    (patch: Partial<HostConfigInputV2>) => {
      onChange({ ...value, ...patch });
    },
    [value, onChange],
  );

  const updateConnection = useCallback(
    (patch: Partial<HostConfigInputV2["connectionDefaults"]>) => {
      onChange({
        ...value,
        connectionDefaults: { ...value.connectionDefaults, ...patch },
      });
    },
    [value, onChange],
  );

  const showExecutionSection = owner !== "connection-only";
  const showServersSection = owner !== "connection-only";

  const hostStyleOptions = useMemo(() => listHostStyles(), []);

  return (
    <div className={className}>
      {caption ? (
        <p className="text-xs text-muted-foreground mb-3">{caption}</p>
      ) : null}

      {showExecutionSection ? (
        <>
          <section className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor={`${reactId}-modelId`}>Model</Label>
              <input
                id={`${reactId}-modelId`}
                className="w-full rounded border px-3 py-2 text-sm"
                value={value.modelId}
                onChange={(e) => update({ modelId: e.target.value })}
                placeholder="claude-sonnet-4-5"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={`${reactId}-systemPrompt`}>System prompt</Label>
              <Textarea
                id={`${reactId}-systemPrompt`}
                rows={6}
                value={value.systemPrompt}
                onChange={(e) => update({ systemPrompt: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Temperature</Label>
                <span className="text-xs text-muted-foreground">
                  {value.temperature.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[value.temperature]}
                min={0}
                max={2}
                step={0.05}
                onValueChange={(values) =>
                  update({
                    temperature: values[0] ?? DEFAULT_TEMPERATURE_V2,
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor={`${reactId}-toolApproval`}>
                Require tool approval
              </Label>
              <Switch
                id={`${reactId}-toolApproval`}
                checked={value.requireToolApproval}
                onCheckedChange={(checked) =>
                  update({ requireToolApproval: checked })
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={`${reactId}-hostStyle`}>Host style</Label>
              <Select
                value={value.hostStyle}
                onValueChange={(next) =>
                  update({ hostStyle: next as HostStyleId })
                }
              >
                <SelectTrigger id={`${reactId}-hostStyle`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hostStyleOptions.map((style) => (
                    <SelectItem key={style.id} value={style.id}>
                      {style.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <Separator className="my-6" />
        </>
      ) : null}

      {showServersSection ? (
        <>
          <section className="space-y-4">
            <ServerCheckboxList
              label="Required servers"
              selected={value.serverIds}
              available={availableServers ?? []}
              onChange={(serverIds) => update({ serverIds })}
            />
            <ServerCheckboxList
              label="Optional servers"
              selected={value.optionalServerIds}
              available={availableServers ?? []}
              onChange={(optionalServerIds) => update({ optionalServerIds })}
            />
          </section>

          <Separator className="my-6" />
        </>
      ) : null}

      <section className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor={`${reactId}-timeout`}>Request timeout (ms)</Label>
          <input
            id={`${reactId}-timeout`}
            type="number"
            min={0}
            className="w-full rounded border px-3 py-2 text-sm"
            value={value.connectionDefaults.requestTimeout}
            onChange={(e) =>
              updateConnection({
                requestTimeout: Number(e.target.value) || 0,
              })
            }
          />
        </div>

        <div className="grid gap-2">
          <Label>Connection headers (JSON)</Label>
          <JsonRecordEditor
            value={value.connectionDefaults.headers}
            onChange={(headers) =>
              updateConnection({
                headers: headers as Record<string, string>,
              })
            }
            placeholder='{"X-Header":"value"}'
          />
        </div>

        <div className="grid gap-2">
          <Label>Client capabilities (JSON)</Label>
          <JsonRecordEditor
            value={value.clientCapabilities}
            onChange={(clientCapabilities) =>
              update({ clientCapabilities })
            }
            placeholder="{}"
          />
        </div>

        <div className="grid gap-2">
          <Label>Host context (JSON)</Label>
          <JsonRecordEditor
            value={value.hostContext}
            onChange={(hostContext) => update({ hostContext })}
            placeholder="{}"
          />
        </div>
      </section>
    </div>
  );
}

function ServerCheckboxList({
  label,
  selected,
  available,
  onChange,
}: {
  label: string;
  selected: string[];
  available: ReadonlyArray<{ id: string; name: string }>;
  onChange: (ids: string[]) => void;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selectedSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(Array.from(next));
    },
    [selectedSet, onChange],
  );

  if (available.length === 0) {
    return (
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground mt-1">
          No servers available in this project.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="grid gap-1 max-h-40 overflow-y-auto rounded border px-2 py-2">
        {available.map((srv) => (
          <label
            key={srv.id}
            className="flex items-center gap-2 text-sm cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selectedSet.has(srv.id)}
              onChange={() => toggle(srv.id)}
            />
            <span>{srv.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Minimal JSON-record editor: textarea backed by JSON.parse on blur.
 * Phase 1 uses this to keep the editor self-contained. Real builders for
 * client capabilities (already exists in the codebase) replace this in
 * later phases.
 */
function JsonRecordEditor({
  value,
  onChange,
  placeholder,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  placeholder?: string;
}) {
  const stringified = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [raw, setRaw] = useState(stringified);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local text whenever the parent's serialized form changes (e.g.
  // a different config gets loaded). We avoid clobbering mid-edit drafts
  // by only re-syncing when the stringified parent value changes.
  useEffect(() => {
    setRaw(stringified);
    setError(null);
  }, [stringified]);

  return (
    <div className="grid gap-1">
      <Textarea
        rows={4}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(raw || "{}");
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              setError("Must be a JSON object");
              return;
            }
            setError(null);
            onChange(parsed as Record<string, unknown>);
          } catch (err) {
            setError(
              err instanceof Error ? err.message : "Invalid JSON",
            );
          }
        }}
        placeholder={placeholder}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
