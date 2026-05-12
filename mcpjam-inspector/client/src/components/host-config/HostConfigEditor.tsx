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

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Label } from "@mcpjam/design-system/label";
import { Input } from "@mcpjam/design-system/input";
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
import { Button } from "@mcpjam/design-system/button";
import {
  type HostConfigInputV2,
  type HostStyleId,
  DEFAULT_TEMPERATURE_V2,
} from "@/lib/host-config-v2";
import { McpProfileSection } from "./McpProfileSection";
import {
  getHostCapabilitiesForStyle,
  listHostStyles,
} from "@/lib/host-styles";

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
  /**
   * Aggregated validity signal. Called with `true` whenever any
   * subsection (currently the JSON record editors) is in an error
   * state. Parent forms should disable Save while invalid.
   */
  onValidityChange?: (hasError: boolean) => void;
}

export function HostConfigEditor({
  value,
  onChange,
  owner = "chatbox",
  availableServers,
  caption,
  className,
  onValidityChange,
}: HostConfigEditorProps) {
  const reactId = useId();

  // Track per-section JSON parse errors. Aggregate into a single boolean
  // and notify the parent whenever it changes so the form can gate Save.
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [hostCtxError, setHostCtxError] = useState<string | null>(null);
  const [hostCapsOverrideError, setHostCapsOverrideError] = useState<
    string | null
  >(null);
  const [mcpProfileHasError, setMcpProfileHasError] = useState(false);
  const hasError =
    headersError != null ||
    capsError != null ||
    hostCtxError != null ||
    hostCapsOverrideError != null ||
    mcpProfileHasError;
  useEffect(() => {
    onValidityChange?.(hasError);
  }, [hasError, onValidityChange]);

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
  // Eval suites own server selection through `suite.environment` —
  // `setSuiteConfig` rejects non-empty serverIds, and the iteration
  // materializer pulls server ids from the suite environment. The
  // editor surface for owner="eval-suite" therefore hides the server
  // picker entirely (and ignores `availableServers`) so users can't
  // type changes the backend would reject.
  const showServersSection =
    owner !== "connection-only" && owner !== "eval-suite";

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
              <Input
                id={`${reactId}-modelId`}
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
              onChange={(serverIds) => {
                // Maintain the invariant the chatbox save path relies on:
                // optionalServerIds is a subset of serverIds. When a
                // server is unchecked from the required list, it must
                // also leave the optional list — otherwise the saved
                // config would describe an "optional server" that isn't
                // even selected.
                const requiredSet = new Set(serverIds);
                update({
                  serverIds,
                  optionalServerIds: value.optionalServerIds.filter((id) =>
                    requiredSet.has(id),
                  ),
                });
              }}
            />
            <ServerCheckboxList
              label="Optional servers"
              selected={value.optionalServerIds}
              available={(availableServers ?? []).filter((srv) =>
                value.serverIds.includes(srv.id),
              )}
              onChange={(optionalServerIds) => {
                // Editing the optional list should never add a server
                // that isn't in serverIds. The available pool above
                // already filters to selected required servers, but
                // belt-and-suspenders: re-clamp here too.
                const requiredSet = new Set(value.serverIds);
                update({
                  optionalServerIds: optionalServerIds.filter((id) =>
                    requiredSet.has(id),
                  ),
                });
              }}
            />
          </section>

          <Separator className="my-6" />
        </>
      ) : null}

      <section className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor={`${reactId}-timeout`}>Request timeout (ms)</Label>
          <Input
            id={`${reactId}-timeout`}
            type="number"
            min={1}
            value={value.connectionDefaults.requestTimeout}
            onChange={(e) => {
              // Preserve the positive-timeout invariant. The legacy
              // connection-settings parser rejects non-positive values and
              // a 0 here would persist an immediate-timeout config. Keep
              // the prior value when the field is cleared or non-positive.
              const parsed = Number(e.target.value);
              if (Number.isFinite(parsed) && parsed > 0) {
                updateConnection({ requestTimeout: parsed });
              }
            }}
          />
        </div>

        <div className="grid gap-2">
          <Label>Connection headers (JSON)</Label>
          <JsonRecordEditor
            value={value.connectionDefaults.headers}
            onChange={(headers) =>
              updateConnection({
                headers: coerceHeadersToStringRecord(headers),
              })
            }
            onErrorChange={setHeadersError}
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
            onErrorChange={setCapsError}
            placeholder="{}"
          />
        </div>

        {owner !== "connection-only" ? (
          <div className="grid gap-2">
            <Label>Host context (JSON)</Label>
            <JsonRecordEditor
              value={value.hostContext}
              onChange={(hostContext) => update({ hostContext })}
              onErrorChange={setHostCtxError}
              placeholder="{}"
            />
          </div>
        ) : null}

        {owner !== "connection-only" ? (
          <HostCapabilitiesOverrideSection
            hostStyle={value.hostStyle}
            override={value.hostCapabilitiesOverride}
            onChange={(hostCapabilitiesOverride) =>
              update({ hostCapabilitiesOverride })
            }
            onErrorChange={setHostCapsOverrideError}
          />
        ) : null}

        {owner !== "connection-only" ? (
          <McpProfileSection
            value={value.mcpProfile}
            onChange={(mcpProfile) => update({ mcpProfile })}
            onErrorChange={setMcpProfileHasError}
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * Editor for the optional MCP Apps `hostCapabilities` override (advertised in
 * `ui/initialize`). When the override is undefined, the renderer falls back
 * to the active host style's preset; this section shows that preset as the
 * placeholder so users can see what they'd be overriding. Resetting writes
 * `undefined`, which snaps back to the preset.
 *
 * CONFORMANCE GAP: this configures the *advertised* blob. Behavior gating
 * inside request handlers is a separate, deferred step (see
 * registerBridgeHandlers in mcp-apps-renderer.tsx).
 */
function HostCapabilitiesOverrideSection({
  hostStyle,
  override,
  onChange,
  onErrorChange,
}: {
  hostStyle: HostStyleId;
  override: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  onErrorChange: (error: string | null) => void;
}) {
  const profilePreset = useMemo(
    () => getHostCapabilitiesForStyle(hostStyle),
    [hostStyle],
  );
  const profilePresetJson = useMemo(
    () => JSON.stringify(profilePreset, null, 2),
    [profilePreset],
  );
  const isOverriding = override !== undefined;
  // When the user hasn't set an override, seed the editor with the profile
  // preset (writeable copy) so they have a visible starting point for edits.
  const editorValue = isOverriding ? override : (profilePreset as Record<string, unknown>);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Host capabilities override (JSON)</Label>
        {isOverriding ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(undefined)}
          >
            Reset to {hostStyle} preset
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Using {hostStyle} preset
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Advertised in <code>ui/initialize</code>. Leave at the preset to match
        the vendor; override to mock specific capability combinations.
      </p>
      <JsonRecordEditor
        value={editorValue}
        onChange={(next) => onChange(next)}
        onErrorChange={onErrorChange}
        placeholder={profilePresetJson}
      />
    </div>
  );
}

/**
 * Coerce a parsed JSON object into a `Record<string, string>` suitable for
 * HTTP headers. Non-string values are converted via `String(...)`; nested
 * objects/arrays/null are dropped. The JsonRecordEditor only validates the
 * outer shape (non-array object), so values can be anything.
 *
 * Drops:
 *   - empty / whitespace-only keys (the legacy project-default
 *     normalizer also filters these; an empty header name would later
 *     fail when merged into requestInit.headers).
 *   - `Authorization` (case-insensitive) — the existing connection-
 *     settings parser rejects it and the project-default normalizer
 *     strips it, so accepting it would either fail later validation or
 *     persist a credential-bearing default.
 */
function coerceHeadersToStringRecord(
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) {
    if (k.trim() === "") continue;
    if (k.toLowerCase() === "authorization") continue;
    if (val == null) continue;
    if (typeof val === "object") continue;
    out[k] = String(val);
  }
  return out;
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
 *
 * Exposes parse errors via `onErrorChange` so the parent form can disable
 * its Save button while any field is invalid. Errors are cleared as soon
 * as the user enters valid JSON or the parent value changes.
 */
function JsonRecordEditor({
  value,
  onChange,
  onErrorChange,
  placeholder,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onErrorChange?: (error: string | null) => void;
  placeholder?: string;
}) {
  const stringified = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [raw, setRaw] = useState(stringified);
  const [error, setErrorState] = useState<string | null>(null);
  // Tracks the stringified form we most recently emitted up via
  // onChange. The resync effect compares `stringified` against this;
  // matches mean the re-render is a self-edit echo and we leave the
  // textarea alone (avoids prettifying the user's input mid-keystroke
  // and wiping cursor position).
  const lastEmittedRef = useRef(stringified);
  // Tracks the most recent parent `value` reference we observed, so we
  // can detect a controlled reset (a new parent reference whose
  // serialized form happens to match the last emitted one). Without
  // this we'd miss the case where the user typed invalid JSON, the
  // parent then resets/loads a config that serializes identically to
  // the last valid value, and our textarea+error stay stuck.
  const lastValueRef = useRef(value);

  const setError = useCallback(
    (next: string | null) => {
      setErrorState(next);
      onErrorChange?.(next);
    },
    [onErrorChange],
  );

  // Re-sync local text whenever:
  //  - the parent's serialized form differs from our last emit
  //    (genuine external change), OR
  //  - the parent passed a new `value` reference while we are showing
  //    a parse error (controlled reset path: invalid drafts must clear
  //    even when the new value happens to canonicalize to the same
  //    string we last emitted).
  useEffect(() => {
    const referenceChanged = value !== lastValueRef.current;
    const stringifiedChanged = stringified !== lastEmittedRef.current;
    if (stringifiedChanged || (referenceChanged && error != null)) {
      setRaw(stringified);
      lastEmittedRef.current = stringified;
      setError(null);
    }
    lastValueRef.current = value;
  }, [value, stringified, error, setError]);

  // Clear the error signal when this editor unmounts (e.g. owner
  // switched to a mode that hides this section). Without this, the
  // parent's aggregated hasError signal would stay stuck on a stale
  // error from a section the user can no longer see, keeping Save
  // disabled with no visible cause to fix.
  useEffect(() => {
    return () => {
      onErrorChange?.(null);
    };
    // We intentionally don't depend on onErrorChange — only fire on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Parse on every keystroke so errors clear as soon as the user fixes
  // them and the parent's `onChange`/`onErrorChange` signals stay live.
  // We still only call `onChange` (committing the parsed value) on
  // successful parses; partial drafts don't propagate.
  const tryParse = useCallback(
    (next: string) => {
      try {
        const parsed = JSON.parse(next || "{}");
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          setError("Must be a JSON object");
          return;
        }
        setError(null);
        // Compute the post-onChange canonical form (what the parent
        // will serialize) and capture it so the resync effect treats
        // the upcoming re-render as a self-edit.
        lastEmittedRef.current = JSON.stringify(
          parsed as Record<string, unknown>,
          null,
          2,
        );
        onChange(parsed as Record<string, unknown>);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid JSON");
      }
    },
    [onChange, setError],
  );

  return (
    <div className="grid gap-1">
      <Textarea
        rows={4}
        value={raw}
        onChange={(e) => {
          const next = e.target.value;
          setRaw(next);
          tryParse(next);
        }}
        placeholder={placeholder}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
