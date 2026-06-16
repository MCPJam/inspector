/**
 * Authoring UI for the deterministic predicate gate ("Checks" in user-facing
 * copy; `Predicate` / `predicateValidator` / `defaultPredicates` in code, per
 * the Phase 2 plan UI-wording mapping).
 *
 * Two surfaces:
 *
 *  - {@link ChecksSection} — list editor + Add-check dropdown, used by both
 *    the suite-edit page ("Default checks") and the case-edit form (when
 *    mode is `replace` or `extend`).
 *  - {@link CaseChecksSection} — case-edit wrapper around ChecksSection that
 *    adds the 3-state inherit/replace/extend radio and the inherited-suite
 *    summary, persisting to `testCase.predicates: { mode, list }`.
 *
 * The list editor itself uses {@link CheckRow} per kind. Form-boundary
 * validation runs the SDK Zod (`predicateSchema`) — invalid rows surface an
 * inline error and disable save up the tree.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Switch } from "@mcpjam/design-system/switch";
import { Trash2, Plus, X } from "lucide-react";
import { ArgLeafPicker } from "./arg-leaf-picker";
import type {
  Predicate,
  ArgMatchMode,
  CasePredicates,
} from "@/shared/eval-matching";
import { predicateSchema } from "@mcpjam/sdk/predicates";
import { OverrideBadge } from "./override-badge";

// ─── kind metadata ────────────────────────────────────────────────────────
//
// One source of truth for the Add-check menu + per-row label. UI wording
// here is the user-facing "checks" vocabulary; the backend `type` discriminator
// is unchanged (Phase 2 plan: "UI says 'checks' everywhere. Internal code keeps
// `Predicate` … to match SDK names").

type Kind = Predicate["type"];

const KIND_LABELS: Record<Kind, string> = {
  toolCalledWith: "Tool was called with…",
  toolCalledAtLeastOnce: "Tool was called at least once",
  toolNeverCalled: "Tool was never called",
  firstToolWas: "First tool called was…",
  responseContains: "Response contains…",
  responseMatches: "Response matches regex…",
  noToolErrors: "No tool errors",
  finalAssistantMessageNonEmpty: "Final message non-empty",
  tokenBudgetUnder: "Token budget under N",
  widgetRendered: "Widget rendered",
  widgetRenderLatencyUnder: "Widget rendered under N ms",
  widgetNoConsoleErrors: "No widget console errors",
};

// Order chosen so tool-call checks cluster first, then response checks, then
// no-arg checks, then resource checks. Matches the Phase 2 plan UI listing.
const KIND_ORDER: Kind[] = [
  "toolCalledWith",
  "toolCalledAtLeastOnce",
  "toolNeverCalled",
  "firstToolWas",
  "responseContains",
  "responseMatches",
  "noToolErrors",
  "finalAssistantMessageNonEmpty",
  "tokenBudgetUnder",
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
];

// Widget render checks ship behind the synthetic-monitors rollout. Existing
// rows of these kinds always render (deleting another team member's check by
// hiding it would be worse); only the Add-check menu is gated.
const SYNTHETIC_MONITOR_KINDS: ReadonlySet<Kind> = new Set([
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
]);

/** Build a fresh, valid-by-default predicate skeleton for a newly-added row. */
export function blankPredicate(kind: Predicate["type"]): Predicate {
  switch (kind) {
    case "toolCalledWith":
      return { type: "toolCalledWith", toolName: "", args: { args: {} } };
    case "toolCalledAtLeastOnce":
      return { type: "toolCalledAtLeastOnce", toolName: "" };
    case "toolNeverCalled":
      return { type: "toolNeverCalled", toolName: "" };
    case "firstToolWas":
      return { type: "firstToolWas", toolName: "" };
    case "responseContains":
      return { type: "responseContains", needle: "" };
    case "responseMatches":
      return { type: "responseMatches", pattern: "" };
    case "noToolErrors":
      return { type: "noToolErrors" };
    case "finalAssistantMessageNonEmpty":
      return { type: "finalAssistantMessageNonEmpty" };
    case "tokenBudgetUnder":
      return { type: "tokenBudgetUnder", tokens: 1000 };
    case "widgetRendered":
      return { type: "widgetRendered" };
    case "widgetRenderLatencyUnder":
      return { type: "widgetRenderLatencyUnder", ms: 3000 };
    case "widgetNoConsoleErrors":
      return { type: "widgetNoConsoleErrors" };
  }
}

// ─── Top-level checks list editor (shared between suite + case) ───────────

export interface ChecksSectionProps {
  /** The list to render and edit. */
  value: Predicate[];
  onChange: (next: Predicate[]) => void;
  /** Tools available from the suite-attached server, for the tool dropdowns. */
  availableTools?: string[];
  /** Header label override. */
  title?: string;
  /** Subtitle/explainer. */
  description?: string;
  /** Hide the Add-check button (used by the inherited read-only summary). */
  readOnly?: boolean;
}

export function ChecksSection({
  value,
  onChange,
  availableTools,
  title = "Default checks",
  description,
  readOnly = false,
  hideAddButton = false,
  hideEmptyState = false,
}: ChecksSectionProps & { hideAddButton?: boolean; hideEmptyState?: boolean }) {
  const updateAt = (index: number, next: Predicate) => {
    const copy = value.slice();
    copy[index] = next;
    onChange(copy);
  };
  const removeAt = (index: number) => {
    const copy = value.slice();
    copy.splice(index, 1);
    onChange(copy);
  };
  const addOfKind = (kind: Kind) => {
    onChange([...value, blankPredicate(kind)]);
  };

  const showHeader = Boolean(title) || Boolean(description);
  return (
    <div className="space-y-3">
      {showHeader ? (
        <div>
          {title ? (
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          ) : null}
          {description ? (
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          ) : null}
        </div>
      ) : null}

      {value.length === 0 ? (
        hideEmptyState ? null : (
          <p className="text-xs italic text-muted-foreground/70">
            No checks set
            {!readOnly ? " — every case passes the gate by default." : "."}
          </p>
        )
      ) : (
        <ul className="space-y-2">
          {value.map((predicate, i) => (
            <li key={i}>
              <CheckRow
                predicate={predicate}
                onChange={readOnly ? () => {} : (next) => updateAt(i, next)}
                onRemove={readOnly ? undefined : () => removeAt(i)}
                availableTools={availableTools}
                readOnly={readOnly}
              />
            </li>
          ))}
        </ul>
      )}

      {!readOnly && !hideAddButton ? <AddCheckMenu onAdd={addOfKind} /> : null}
    </div>
  );
}

export function AddCheckMenu({
  onAdd,
}: {
  onAdd: (kind: Predicate["type"]) => void;
}) {
  // A controlled Select where picking a value fires `onAdd` and resets to
  // the placeholder — simpler than a popover menu and reuses design-system
  // primitives that already render correctly inside dialogs/sheets.
  const [open, setOpen] = useState(false);
  const syntheticMonitorsEnabled = useFeatureFlagEnabled("synthetic-monitors");
  const kinds = syntheticMonitorsEnabled
    ? KIND_ORDER
    : KIND_ORDER.filter((kind) => !SYNTHETIC_MONITOR_KINDS.has(kind));
  return (
    <div className="flex items-center gap-2">
      <Select
        open={open}
        onOpenChange={setOpen}
        value=""
        onValueChange={(kind) => {
          if (!kind) return;
          onAdd(kind as Kind);
          setOpen(false);
        }}
      >
        <SelectTrigger className="h-8 w-auto gap-2 text-xs">
          <Plus className="h-3.5 w-3.5" />
          <SelectValue placeholder="Add check…" />
        </SelectTrigger>
        <SelectContent>
          {kinds.map((kind) => (
            <SelectItem key={kind} value={kind} className="text-xs">
              {KIND_LABELS[kind]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Per-row editor (shared across kinds) ─────────────────────────────────

export interface CheckRowProps {
  predicate: Predicate;
  onChange: (next: Predicate) => void;
  onRemove?: () => void;
  availableTools?: string[];
  readOnly?: boolean;
}

export function CheckRow({
  predicate,
  onChange,
  onRemove,
  availableTools,
  readOnly = false,
}: CheckRowProps) {
  // Zod-validate the current row so an in-progress edit (e.g. empty toolName,
  // malformed args JSON) surfaces an inline error and disables Save up the
  // tree (callers wire `isAnyCheckInvalid` into their disable state).
  const validation = useMemo(
    () => predicateSchema.safeParse(predicate),
    [predicate],
  );
  const error = validation.success
    ? null
    : validation.error.issues.map((i) => i.message).join("; ");

  return (
    <div
      className={`rounded-md border p-3 ${
        error ? "border-red-500/40 bg-red-500/5" : "border-border/60 bg-muted/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {KIND_LABELS[predicate.type]}
          </div>

          <CheckFields
            predicate={predicate}
            onChange={onChange}
            availableTools={availableTools}
            readOnly={readOnly}
          />

          {error ? (
            <div className="text-[11px] text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : null}
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground"
            onClick={onRemove}
            aria-label="Remove check"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CheckFields({
  predicate,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: Predicate;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  switch (predicate.type) {
    case "toolCalledWith":
      return (
        <ToolCalledWithFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "toolCalledAtLeastOnce":
    case "toolNeverCalled":
    case "firstToolWas":
      return (
        <ToolNameField
          value={predicate.toolName}
          onChange={(toolName) =>
            onChange({ ...predicate, toolName } as Predicate)
          }
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "responseContains":
      return (
        <ResponseContainsFields
          predicate={predicate}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "responseMatches":
      return (
        <ResponseMatchesFields
          predicate={predicate}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "noToolErrors":
      return (
        <div className="text-xs text-muted-foreground">
          Passes when no tool reported an error (neither MCP isError nor a
          transport failure).
        </div>
      );
    case "finalAssistantMessageNonEmpty":
      return (
        <div className="text-xs text-muted-foreground">
          Passes when the final assistant message contains non-whitespace text.
        </div>
      );
    case "tokenBudgetUnder":
      return (
        <TokenBudgetField
          predicate={predicate}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "widgetRendered":
      return (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Passes when at least one MCP App widget rendered during the
            iteration. Fails when the run recorded no widget renders.
          </div>
          <WidgetToolFilterField
            value={predicate.toolName}
            onChange={(toolName) =>
              onChange(
                toolName === undefined
                  ? { type: "widgetRendered" }
                  : { type: "widgetRendered", toolName },
              )
            }
            availableTools={availableTools}
            readOnly={readOnly}
          />
        </div>
      );
    case "widgetRenderLatencyUnder":
      return (
        <WidgetLatencyFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "widgetNoConsoleErrors":
      return (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Passes when no rendered widget logged console errors. Fails when
            the run recorded no widget renders.
          </div>
          <WidgetToolFilterField
            value={predicate.toolName}
            onChange={(toolName) =>
              onChange(
                toolName === undefined
                  ? { type: "widgetNoConsoleErrors" }
                  : { type: "widgetNoConsoleErrors", toolName },
              )
            }
            availableTools={availableTools}
            readOnly={readOnly}
          />
        </div>
      );
  }
}

// ─── Per-kind field components ────────────────────────────────────────────

function ToolNameField({
  value,
  onChange,
  availableTools,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const id = useId();
  // When a suite has attached servers and we know the tool list, prefer a
  // dropdown to prevent typos. Fall back to free text otherwise (legacy
  // suites without an attached server, or for tools the editor doesn't
  // know about yet).
  const useDropdown = availableTools && availableTools.length > 0;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        Tool
      </Label>
      {useDropdown && !readOnly ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger id={id} className="h-8 text-xs">
            <SelectValue placeholder="Pick a tool…" />
          </SelectTrigger>
          <SelectContent>
            {availableTools!.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. search"
          className="h-8 text-xs"
          disabled={readOnly}
        />
      )}
    </div>
  );
}

function ToolCalledWithFields({
  predicate,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "toolCalledWith" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const minCountId = useId();
  return (
    <div className="space-y-3">
      <ToolNameField
        value={predicate.toolName}
        onChange={(toolName) => onChange({ ...predicate, toolName })}
        availableTools={availableTools}
        readOnly={readOnly}
      />
      <ArgMatcherSubform
        value={predicate.args}
        onChange={(args) => onChange({ ...predicate, args })}
        readOnly={readOnly}
      />
      <div className="space-y-1">
        <Label htmlFor={minCountId} className="text-[11px]">
          Minimum matching calls (optional)
        </Label>
        <Input
          id={minCountId}
          type="number"
          min={1}
          step={1}
          value={predicate.minCount ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              const next = { ...predicate };
              delete next.minCount;
              onChange(next);
              return;
            }
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            onChange({ ...predicate, minCount: Math.floor(n) });
          }}
          placeholder="1"
          className="h-8 w-32 text-xs"
          disabled={readOnly}
        />
      </div>
    </div>
  );
}

/** True iff `v` is a nested JSON container (object or array). The
 *  structured per-leaf editor handles only flat top-level keys; nested
 *  shapes fall back to the raw JSON view so users can author them
 *  without a tree-builder. */
function isNestedContainer(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  return Array.isArray(v) || Object.keys(v as Record<string, unknown>).length > 0;
}

/** True iff every top-level value in `args` is a flat leaf (not a nested
 *  object/array). When true, the structured editor is enabled by
 *  default; otherwise we render the JSON view because the structured
 *  one can't roundtrip nested shapes losslessly. */
function argsAreFlat(args: Record<string, unknown>): boolean {
  for (const v of Object.values(args)) {
    if (isNestedContainer(v)) return false;
  }
  return true;
}

/**
 * Sub-form for the `toolCalledWith.args` shape. Phase 3:
 *
 *   - **Structured editor (default for flat args)**: one row per top-level
 *     key, key Input + {@link ArgLeafPicker} as the value control. The
 *     picker switches between literal and placeholder modes based on the
 *     parent `argumentMatching` selection.
 *   - **Raw JSON editor (fallback)**: the Phase 2 JSON textarea, used when
 *     args contain nested objects/arrays (the structured view can't
 *     authoring-edit those without becoming a full tree builder, which is
 *     out of scope for V1).
 *
 * The persisted shape is unchanged — `value.args` remains a
 * `Record<string, unknown>` and placeholder leaves are the literal
 * placeholder strings the matcher already interprets.
 */
function ArgMatcherSubform({
  value,
  onChange,
  readOnly,
}: {
  value: { args: Record<string, unknown>; argumentMatching?: ArgMatchMode };
  onChange: (next: {
    args: Record<string, unknown>;
    argumentMatching?: ArgMatchMode;
  }) => void;
  readOnly: boolean;
}) {
  const modeId = useId();
  const mode: ArgMatchMode = value.argumentMatching ?? "partial";

  // The structured editor is the default surface when args are flat.
  // If the user has authored nested args via the raw editor, we default
  // to raw to preserve their shape. They can still toggle either way.
  const [useRaw, setUseRaw] = useState<boolean>(
    () => !argsAreFlat(value.args ?? {}),
  );

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div className="space-y-1">
          <Label htmlFor={modeId} className="text-[11px]">
            Argument matching
          </Label>
          <Select
            value={mode}
            onValueChange={(next) =>
              onChange({ ...value, argumentMatching: next as ArgMatchMode })
            }
            disabled={readOnly}
          >
            <SelectTrigger id={modeId} className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="partial" className="text-xs">
                Partial (extras ok)
              </SelectItem>
              <SelectItem value="exact" className="text-xs">
                Exact (deep equal)
              </SelectItem>
              <SelectItem value="ignore" className="text-xs">
                Ignore (only tool name matters)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* Per-row "Raw JSON" toggle so power users can author nested
            shapes the structured editor can't express. Disabled in
            ignore mode (args aren't compared anyway). */}
        <div className="flex items-center gap-1.5 pb-1">
          <Switch
            id={`${modeId}-raw`}
            checked={useRaw}
            onCheckedChange={(checked) => setUseRaw(checked)}
            disabled={readOnly || mode === "ignore"}
            aria-label="Use raw JSON editor"
          />
          <Label
            htmlFor={`${modeId}-raw`}
            className="text-[10px] text-muted-foreground"
          >
            Raw JSON
          </Label>
        </div>
      </div>
      {mode === "ignore" ? (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/10 p-3 text-[11px] italic text-muted-foreground">
          Arguments not compared in ignore mode.
        </div>
      ) : useRaw ? (
        <RawArgsJsonEditor
          value={value.args ?? {}}
          onChange={(args) => onChange({ ...value, args })}
          mode={mode}
          readOnly={readOnly}
        />
      ) : (
        <StructuredArgsEditor
          value={value.args ?? {}}
          onChange={(args) => onChange({ ...value, args })}
          mode={mode}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

/**
 * Per-leaf authoring view for flat args: list of `{ key, value }` rows
 * where each value uses {@link ArgLeafPicker} to switch between literal
 * and placeholder modes. Operates on the same persisted shape as the
 * raw view.
 */
function StructuredArgsEditor({
  value,
  onChange,
  mode,
  readOnly,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: ArgMatchMode;
  readOnly: boolean;
}) {
  // Stable ordering for the row list: insertion order via Object.entries.
  const entries = Object.entries(value);

  const setEntry = (oldKey: string, newKey: string, newValue: unknown) => {
    // Preserve insertion order when renaming a key; replace in place.
    const next: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (k === oldKey) next[newKey] = newValue;
      else next[k] = v;
    }
    onChange(next);
  };
  const removeKey = (key: string) => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of entries) if (k !== key) next[k] = v;
    onChange(next);
  };
  const addEmpty = () => {
    // Pick a fresh unique key. Don't collide with existing keys; numeric
    // suffixes are an ergonomic default familiar from ExpectedToolsEditor.
    let candidate = "arg";
    let i = 1;
    while (Object.hasOwn(value, candidate)) {
      candidate = `arg${i++}`;
    }
    onChange({ ...value, [candidate]: "" });
  };

  return (
    <div className="space-y-2">
      {entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/10 p-3 text-[11px] text-muted-foreground">
          No expected arguments. Use Add argument below.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([key, val]) => (
            <StructuredArgsRow
              // `key` here doubles as React's reconciliation id AND the
              // current persisted key. The row keeps its own draft of
              // edits so intermediate collisions don't lose user input.
              key={key}
              persistedKey={key}
              value={val}
              mode={mode}
              readOnly={readOnly}
              isKeyTaken={(candidate) =>
                candidate !== key && Object.hasOwn(value, candidate)
              }
              onCommitKey={(newKey) => setEntry(key, newKey, val)}
              onChangeValue={(next) => setEntry(key, key, next)}
              onRemove={() => removeKey(key)}
            />
          ))}
        </ul>
      )}
      {!readOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={addEmpty}
        >
          <Plus className="mr-1 h-3 w-3" />
          Add argument
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Single row in {@link StructuredArgsEditor}. Owns a draft of the key
 * input so a rename to a colliding name doesn't immediately overwrite
 * another row (sequential writes in the parent's loop made the loser
 * non-deterministic). On collision we render a red border and suppress
 * the commit; the user fixes the name (or leaves it equal to the
 * persisted key) before any onChange fires upward. Value edits commit
 * normally — they're independent of the key rename.
 */
function StructuredArgsRow({
  persistedKey,
  value,
  mode,
  readOnly,
  isKeyTaken,
  onCommitKey,
  onChangeValue,
  onRemove,
}: {
  persistedKey: string;
  value: unknown;
  mode: ArgMatchMode;
  readOnly: boolean;
  isKeyTaken: (candidate: string) => boolean;
  onCommitKey: (next: string) => void;
  onChangeValue: (next: unknown) => void;
  onRemove: () => void;
}) {
  const [draftKey, setDraftKey] = useState(persistedKey);

  // Re-sync the draft when the persisted key changes (e.g. a successful
  // upstream commit, or an out-of-band reset).
  useEffect(() => {
    setDraftKey(persistedKey);
  }, [persistedKey]);

  const collides = draftKey !== persistedKey && isKeyTaken(draftKey);
  const isEmpty = draftKey.length === 0;

  return (
    <li className="flex items-start gap-1.5 rounded-md bg-background/60 p-1.5 ring-1 ring-border/30">
      <div className="flex flex-col">
        <Input
          value={draftKey}
          onChange={(e) => {
            const candidate = e.target.value;
            setDraftKey(candidate);
            // Only commit when the candidate is unique and non-empty;
            // collisions / empties stay in local state so the user can
            // finish typing without overwriting another row.
            if (candidate === persistedKey) return;
            if (candidate.length === 0) return;
            if (isKeyTaken(candidate)) return;
            onCommitKey(candidate);
          }}
          placeholder="key"
          className={
            "h-9 w-28 shrink-0 font-mono text-xs" +
            (collides || isEmpty
              ? " border-destructive focus-visible:ring-destructive"
              : "")
          }
          disabled={readOnly}
          aria-invalid={collides || isEmpty ? true : undefined}
          aria-label="Argument key"
          title={
            collides
              ? "Key already exists"
              : isEmpty
                ? "Key cannot be empty"
                : undefined
          }
        />
        {collides ? (
          <span className="mt-0.5 text-[10px] text-destructive">
            Key already exists
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <ArgLeafPicker
          value={value}
          onChange={(next) => onChangeValue(next)}
          argumentMatching={mode}
          disabled={readOnly}
        />
      </div>
      {!readOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove argument ${persistedKey}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Raw JSON authoring view, preserved from Phase 2 so users with nested
 * args can still edit them as text. Maintained as a separate component
 * so the structured editor doesn't have to inherit its draft-text state.
 */
function RawArgsJsonEditor({
  value,
  onChange,
  mode,
  readOnly,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: ArgMatchMode;
  readOnly: boolean;
}) {
  const argsId = useId();
  const formatValue = (v: unknown): string => {
    try {
      return JSON.stringify(v ?? {}, null, 2);
    } catch {
      return "{}";
    }
  };
  const [draftJson, setDraftJson] = useState(() => formatValue(value));
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Resync the draft text when `value` changes from outside this instance
  // (e.g. switching cases, deleting/reordering checks). Predicate rows are
  // keyed by index, so the same RawArgsJsonEditor instance is reused with
  // a different `value` prop — without this, the textarea kept showing the
  // previous predicate's JSON and the next edit could clobber the new
  // predicate's args. We compare against the parse of our own draft to
  // avoid overwriting mid-edit (when the user's draft is the upstream of
  // `value`, JSON parses equal and we leave the text alone).
  useEffect(() => {
    let drift = true;
    try {
      const parsed = JSON.parse(draftJson);
      drift = JSON.stringify(parsed) !== JSON.stringify(value ?? {});
    } catch {
      drift = true;
    }
    if (drift) {
      setDraftJson(formatValue(value));
      setJsonError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="space-y-1">
      <Label htmlFor={argsId} className="text-[11px]">
        Expected args (JSON)
        {mode === "partial" ? (
          <span className="ml-2 text-muted-foreground font-normal">
            Placeholders allowed: "string", "number", "boolean", "object",
            "array", "null", "any"
          </span>
        ) : null}
      </Label>
      <textarea
        id={argsId}
        className={`min-h-[80px] w-full rounded-md border bg-background p-2 font-mono text-[11px] leading-tight ${
          jsonError ? "border-red-500/60" : "border-border/60"
        }`}
        value={draftJson}
        onChange={(e) => {
          const next = e.target.value;
          setDraftJson(next);
          try {
            const parsed = JSON.parse(next);
            if (
              parsed === null ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              setJsonError("Expected a JSON object");
              return;
            }
            setJsonError(null);
            onChange(parsed as Record<string, unknown>);
          } catch (err) {
            setJsonError(err instanceof Error ? err.message : "Invalid JSON");
          }
        }}
        spellCheck={false}
        disabled={readOnly}
      />
      {jsonError ? (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          {jsonError}
        </div>
      ) : null}
    </div>
  );
}

function ResponseContainsFields({
  predicate,
  onChange,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "responseContains" }>;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
}) {
  const needleId = useId();
  const csId = useId();
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={needleId} className="text-[11px]">
          Needle
        </Label>
        <Input
          id={needleId}
          value={predicate.needle}
          onChange={(e) => onChange({ ...predicate, needle: e.target.value })}
          placeholder="e.g. refund issued"
          className="h-8 text-xs"
          disabled={readOnly}
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={csId}
          checked={predicate.caseSensitive ?? false}
          onCheckedChange={(checked) =>
            onChange({ ...predicate, caseSensitive: checked })
          }
          disabled={readOnly}
        />
        <Label htmlFor={csId} className="text-[11px]">
          Case sensitive
        </Label>
      </div>
    </div>
  );
}

function ResponseMatchesFields({
  predicate,
  onChange,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "responseMatches" }>;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
}) {
  const id = useId();
  // Live-validate the regex on input. An invalid pattern shows inline and the
  // row-level Zod validation will also flag it (empty pattern). We don't
  // attempt to detect ReDoS here — the evaluator has its own heuristic guard.
  let regexError: string | null = null;
  if (predicate.pattern) {
    try {
      new RegExp(predicate.pattern);
    } catch (e) {
      regexError = e instanceof Error ? e.message : "Invalid regex";
    }
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        Regex pattern (no surrounding slashes)
      </Label>
      <Input
        id={id}
        value={predicate.pattern}
        onChange={(e) => onChange({ ...predicate, pattern: e.target.value })}
        placeholder="e.g. ^Order #\\d{4} confirmed$"
        className="h-8 font-mono text-xs"
        disabled={readOnly}
      />
      {regexError ? (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          {regexError}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Optional tool-scope filter shared by the widget render checks. Empty means
 * "all widgets in the iteration"; the Zod schema rejects an empty string, so
 * clearing the field must drop the key entirely (`onChange(undefined)`).
 */
function WidgetToolFilterField({
  value,
  onChange,
  availableTools,
  readOnly,
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const id = useId();
  const ALL = "__all__";
  const useDropdown = availableTools && availableTools.length > 0;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        Limit to tool (optional)
      </Label>
      {useDropdown && !readOnly ? (
        <Select
          value={value ?? ALL}
          onValueChange={(next) => onChange(next === ALL ? undefined : next)}
        >
          <SelectTrigger id={id} className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              All widgets
            </SelectItem>
            {availableTools!.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : e.target.value)
          }
          placeholder="All widgets"
          className="h-8 text-xs"
          disabled={readOnly}
        />
      )}
    </div>
  );
}

function WidgetLatencyFields({
  predicate,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "widgetRenderLatencyUnder" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={id} className="text-[11px]">
          Max render time in ms (strictly under)
        </Label>
        <Input
          id={id}
          type="number"
          min={1}
          step={1}
          value={predicate.ms}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange({ ...predicate, ms: Math.floor(n) });
          }}
          className="h-8 w-32 text-xs"
          disabled={readOnly}
        />
      </div>
      <WidgetToolFilterField
        value={predicate.toolName}
        onChange={(toolName) => {
          const next = { ...predicate };
          if (toolName === undefined) delete next.toolName;
          else next.toolName = toolName;
          onChange(next);
        }}
        availableTools={availableTools}
        readOnly={readOnly}
      />
    </div>
  );
}

function TokenBudgetField({
  predicate,
  onChange,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "tokenBudgetUnder" }>;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        Max tokens (strictly under)
      </Label>
      <Input
        id={id}
        type="number"
        min={1}
        step={1}
        value={predicate.tokens}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange({ ...predicate, tokens: Math.floor(n) });
        }}
        className="h-8 w-32 text-xs"
        disabled={readOnly}
      />
    </div>
  );
}

// ─── Case-edit wrapper: 3-state inherit/replace/extend ────────────────────

export interface CaseChecksSectionProps {
  /** Persisted case-level override; undefined ⇒ inherit suite defaults. */
  value: CasePredicates | undefined;
  onChange: (next: CasePredicates | undefined) => void;
  /** Suite defaults to show in inherit summary and prepend in extend mode. */
  suiteDefaults: Predicate[];
  availableTools?: string[];
  /**
   * When true, render without the outer card chrome (border/background/padding)
   * and without the section header (h3 + description). Used when this section
   * is hosted inside a larger "Pass criteria" disclosure that already owns the
   * outer surface — duplicating the heading reads as a nested card.
   *
   * When embedded, the inherited "ungated" notice also demotes to muted inline
   * text rather than the warning palette: in the embedded surface, the suite-
   * has-no-checks-and-case-inherits state is the boring default, not an alarm.
   */
  embedded?: boolean;
}

/**
 * Resolve a CasePredicates view-model with a default (`inherit`) when
 * undefined, so the 3-state radio always has a checked value to bind to.
 */
function resolveCaseChecks(
  value: CasePredicates | undefined,
): CasePredicates {
  return value ?? { mode: "inherit", list: [] };
}

export function CaseChecksSection({
  value,
  onChange,
  suiteDefaults,
  availableTools,
  embedded = false,
}: CaseChecksSectionProps) {
  const resolved = resolveCaseChecks(value);
  const mode = resolved.mode;

  // Embedded path is the new extend-always model: the case list always
  // layers on top of suite defaults. An empty list = pure inherit; the
  // moment a check is added the persisted shape becomes
  // `{ mode: "extend", list }`. There's no UI to choose "replace" — see
  // [[case-pass-criteria-disclosure]]. Existing rows persisted with
  // `mode: "replace"` will be re-interpreted as extend on first edit.
  if (embedded) {
    const setEmbeddedList = (list: Predicate[]) => {
      if (list.length === 0) {
        onChange(undefined);
      } else {
        onChange({ mode: "extend", list });
      }
    };
    const caseList = resolved.list;
    const hasOwnChecks = caseList.length > 0;
    const inheritedCount = suiteDefaults.length;
    return (
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h4 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Checks
          </h4>
          <AddCheckMenu
            onAdd={(kind) =>
              setEmbeddedList([...caseList, blankPredicate(kind)])
            }
          />
        </div>
        {inheritedCount > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Inherits {inheritedCount} suite default check
            {inheritedCount === 1 ? "" : "s"}. Add case-specific checks below
            to extend them.
          </p>
        ) : !hasOwnChecks ? (
          <p className="text-[11px] italic text-muted-foreground">
            No checks gating this case yet. Add one above, or set suite
            defaults in Suite settings.
          </p>
        ) : null}
        {hasOwnChecks ? (
          <ChecksSection
            title=""
            hideAddButton
            hideEmptyState
            value={caseList}
            onChange={setEmbeddedList}
            availableTools={availableTools}
          />
        ) : null}
      </section>
    );
  }

  // ─── Non-embedded (legacy) path: 3-mode radio kept for the standalone
  //     case-edit usage. The embedded path inside Pass criteria is the
  //     surface in active use; this path remains for any caller that
  //     still wants the full inherit/replace/extend control.

  // When the user toggles modes, preserve a populated list so they can
  // flip back to replace/extend without losing work (Phase 2 deliverable D).
  // But clear list to undefined when switching to inherit AND the list is
  // empty — avoid persisting `{ mode: "inherit", list: [] }` with stale state.
  const setMode = (next: CasePredicates["mode"]) => {
    if (next === "inherit" && resolved.list.length === 0) {
      onChange(undefined);
      return;
    }
    onChange({ mode: next, list: resolved.list });
  };

  const setList = (list: Predicate[]) => {
    onChange({ mode, list });
  };

  const suiteDefaultLabel =
    suiteDefaults.length === 0
      ? "no default checks"
      : `${suiteDefaults.length} default check${suiteDefaults.length === 1 ? "" : "s"}`;
  const overrideKindLabel =
    mode === "replace"
      ? "replace"
      : mode === "extend"
        ? "extend"
        : undefined;
  const handleResetMode = () => onChange(undefined);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Checks</h3>
          <OverrideBadge
            isInheriting={mode === "inherit"}
            suiteDefaultLabel={suiteDefaultLabel}
            overrideKindLabel={overrideKindLabel}
            onReset={mode === "inherit" ? undefined : handleResetMode}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Deterministic checks for this case. Inherit, replace, or extend the
          suite&apos;s default checks.
        </p>
      </div>

      <fieldset className="space-y-1">
        <legend className="sr-only">Check inheritance mode</legend>
        <RadioRow
          name="case-checks-mode"
          value="inherit"
          checked={mode === "inherit"}
          onChange={setMode}
          label="Inherit suite defaults"
        />
        <RadioRow
          name="case-checks-mode"
          value="replace"
          checked={mode === "replace"}
          onChange={setMode}
          label="Replace suite defaults"
        />
        <RadioRow
          name="case-checks-mode"
          value="extend"
          checked={mode === "extend"}
          onChange={setMode}
          label="Extend suite defaults"
        />
      </fieldset>

      {mode === "inherit" ? (
        suiteDefaults.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-xs text-foreground">
            <span aria-hidden className="mt-0.5 text-warning">⚠</span>
            <span>
              Suite has no default checks. This case will be{" "}
              <strong className="font-semibold">ungated</strong> — it will
              always pass on the deterministic-checks axis. Switch to
              Replace or Extend to author case-specific checks.
            </span>
          </div>
        ) : (
          <div className="rounded-md border border-border/40 bg-background p-3 text-xs text-muted-foreground">
            {`${suiteDefaults.length} check${suiteDefaults.length === 1 ? "" : "s"} inherited from suite — view defaults on the suite settings page.`}
          </div>
        )
      ) : null}

      {mode === "extend" && suiteDefaults.length > 0 ? (
        <div className="space-y-2 opacity-70">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Inherited from suite ({suiteDefaults.length})
          </div>
          <ChecksSection
            value={suiteDefaults}
            onChange={() => {}}
            availableTools={availableTools}
            title=""
            readOnly
          />
        </div>
      ) : null}

      {mode === "replace" || mode === "extend" ? (
        <ChecksSection
          value={resolved.list}
          onChange={setList}
          availableTools={availableTools}
          title={mode === "extend" ? "Additional checks for this case" : "Checks for this case"}
        />
      ) : null}
    </div>
  );
}

function RadioRow({
  name,
  value,
  checked,
  onChange,
  label,
}: {
  name: string;
  value: CasePredicates["mode"];
  checked: boolean;
  onChange: (next: CasePredicates["mode"]) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={() => onChange(value)}
        className="h-3 w-3"
      />
      <Label htmlFor={id} className="text-xs cursor-pointer">
        {label}
      </Label>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────

/**
 * True iff every predicate in `list` passes the SDK Zod schema. Callers
 * (suite-edit / case-edit) thread this into Save-button disabled state so
 * the user can't persist a malformed row.
 */
export function areAllChecksValid(list: Predicate[]): boolean {
  return list.every((p) => predicateSchema.safeParse(p).success);
}
