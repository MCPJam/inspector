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
import { Combobox } from "@/components/ui/combobox";
import { ArgLeafPicker } from "./arg-leaf-picker";
import type {
  Predicate,
  ArgMatchMode,
  CasePredicates,
} from "@/shared/eval-matching";
import { predicateSchema } from "@mcpjam/sdk/predicates";
import { OverrideBadge } from "./override-badge";
import { cn } from "@/lib/utils";
import {
  splitPredicatesForMigration,
  stripScenarioPredicatesFromList,
} from "@/shared/predicate-migration";
import {
  blankPredicate,
  filterKindsForMenu,
  GLOBAL_POLICY_MENU_KINDS,
  globalGateLabel,
  isGlobalPolicyKind,
  isScenarioPredicateKind,
  KIND_LABELS,
  KIND_ORDER,
  type Kind,
} from "./predicate-kind-meta";
import { AddGlobalGateMenu } from "./global-gate-menu";
import {
  GlobalGateKindInfoHint,
  GlobalGatesSectionInfoHint,
} from "./global-gates-info";

// Re-export for step-list-editor and other callers.
export { blankPredicate } from "./predicate-kind-meta";

// ─── Top-level checks list editor (shared between suite + case) ───────────

/**
 * Per-tool JSON-schema `properties` map (`toolName → { argName: schema }`),
 * used to drive the argument-name dropdown and value type hints in the
 * `toolCalledWith` editor. Optional: callers without attached-server schemas
 * (e.g. legacy suites) omit it and the argument key falls back to free text.
 */
export type ToolArgSchemas = Record<string, Record<string, any>>;

export interface ChecksSectionProps {
  /** The list to render and edit. */
  value: Predicate[];
  onChange: (next: Predicate[]) => void;
  /** Tools available from the suite-attached server, for the tool dropdowns. */
  availableTools?: string[];
  /** Per-tool input-schema properties, for the argument-name dropdown. */
  toolArgSchemas?: ToolArgSchemas;
  /** Header label override. */
  title?: string;
  /** Subtitle/explainer. */
  description?: string;
  /** Hide the Add-check button (used by the inherited read-only summary). */
  readOnly?: boolean;
  /**
   * Restrict the Add-check menu to these kinds when `globalGatesMenu` is false.
   */
  allowedKinds?: readonly Predicate["type"][];
  /**
   * Global gates surface: Add menu shows whole-run policy kinds only.
   * Legacy scenario predicates on existing rows render read-only.
   */
  globalGatesMenu?: boolean;
}

export function ChecksSection({
  value,
  onChange,
  availableTools,
  toolArgSchemas,
  title = "Default checks",
  description,
  readOnly = false,
  hideAddButton = false,
  hideEmptyState = false,
  allowedKinds,
  globalGatesMenu = false,
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
                onChange={
                  readOnly || (globalGatesMenu && isScenarioPredicateKind(predicate.type))
                    ? () => {}
                    : (next) => updateAt(i, next)
                }
                onRemove={
                  readOnly || (globalGatesMenu && isScenarioPredicateKind(predicate.type))
                    ? undefined
                    : () => removeAt(i)
                }
                availableTools={availableTools}
                toolArgSchemas={toolArgSchemas}
                readOnly={
                  readOnly ||
                  (globalGatesMenu && isScenarioPredicateKind(predicate.type))
                }
                legacyScenarioGate={
                  globalGatesMenu && isScenarioPredicateKind(predicate.type)
                }
                globalGate={
                  globalGatesMenu && isGlobalPolicyKind(predicate.type)
                }
              />
            </li>
          ))}
        </ul>
      )}

      {!readOnly && !hideAddButton ? (
        <AddCheckMenu
          onAdd={addOfKind}
          allowedKinds={
            globalGatesMenu
              ? GLOBAL_POLICY_MENU_KINDS
              : allowedKinds
          }
          globalGatesMenu={globalGatesMenu}
        />
      ) : null}
    </div>
  );
}

export function AddCheckMenu({
  onAdd,
  allowedKinds,
  globalGatesMenu = false,
}: {
  onAdd: (kind: Predicate["type"]) => void;
  /** When set, restrict the menu to these kinds. */
  allowedKinds?: readonly Predicate["type"][];
  globalGatesMenu?: boolean;
}) {
  if (globalGatesMenu) {
    return <AddGlobalGateMenu onAdd={onAdd} />;
  }

  const [open, setOpen] = useState(false);
  const syntheticMonitorsEnabled = useFeatureFlagEnabled("synthetic-monitors");
  const kinds = filterKindsForMenu(
    KIND_ORDER,
    !!syntheticMonitorsEnabled,
    allowedKinds,
  );
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
  toolArgSchemas?: ToolArgSchemas;
  readOnly?: boolean;
  /** Strip outer card chrome + kind header when nested inside a step row. */
  embedded?: boolean;
  /** Scenario predicate still in Global gates list — prompt move to steps. */
  legacyScenarioGate?: boolean;
  /** Compact whole-run gate row (label + hint in header, minimal fields). */
  globalGate?: boolean;
}

export function CheckRow({
  predicate,
  onChange,
  onRemove,
  availableTools,
  toolArgSchemas,
  readOnly = false,
  embedded = false,
  legacyScenarioGate = false,
  globalGate = false,
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
      className={cn(
        embedded
          ? "min-w-0 space-y-3"
          : cn(
              "rounded-md border p-3",
              error
                ? "border-red-500/40 bg-red-500/5"
                : "border-border/60 bg-muted/10",
            ),
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-3">
          {!embedded ? (
            globalGate ? (
              <div className="flex items-center gap-1">
                <div className="text-xs font-medium text-foreground">
                  {globalGateLabel(predicate.type)}
                </div>
                <GlobalGateKindInfoHint kind={predicate.type} />
              </div>
            ) : (
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {KIND_LABELS[predicate.type]}
              </div>
            )
          ) : null}

          <CheckFields
            predicate={predicate}
            onChange={onChange}
            availableTools={availableTools}
            toolArgSchemas={toolArgSchemas}
            readOnly={readOnly}
            compactGlobalGate={globalGate}
          />

          {error ? (
            <div className="text-[11px] text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : null}
          {legacyScenarioGate ? (
            <p className="text-[11px] text-muted-foreground">
              Scenario check — use Move to Steps to edit inline in the flow.
            </p>
          ) : null}
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
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
  toolArgSchemas,
  readOnly,
  compactGlobalGate = false,
}: {
  predicate: Predicate;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  toolArgSchemas?: ToolArgSchemas;
  readOnly: boolean;
  compactGlobalGate?: boolean;
}) {
  switch (predicate.type) {
    case "toolCalledWith":
      return (
        <ToolCalledWithFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          toolArgSchemas={toolArgSchemas}
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
      if (compactGlobalGate) return null;
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
          compact={compactGlobalGate}
        />
      );
    case "widgetRendered":
      return (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Passes when at least one MCP App view rendered during the
            iteration. Fails when the run recorded no view renders.
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
      if (compactGlobalGate) {
        return (
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
        );
      }
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
  toolArgSchemas,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "toolCalledWith" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  toolArgSchemas?: ToolArgSchemas;
  readOnly: boolean;
}) {
  const minCountId = useId();
  // Schema properties for the currently-selected tool, if known. Drives the
  // argument-name dropdown + value type hints below; empty/undefined falls
  // back to free-text keys.
  const argProperties = toolArgSchemas?.[predicate.toolName];
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
        argProperties={argProperties}
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
  argProperties,
  readOnly,
}: {
  value: { args: Record<string, unknown>; argumentMatching?: ArgMatchMode };
  onChange: (next: {
    args: Record<string, unknown>;
    argumentMatching?: ArgMatchMode;
  }) => void;
  argProperties?: Record<string, any>;
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
      <div className="space-y-2">
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
            <SelectTrigger id={modeId} className="h-8 w-full text-xs">
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
        <div className="flex items-center justify-end gap-2">
          <Switch
            id={`${modeId}-raw`}
            checked={useRaw}
            onCheckedChange={(checked) => setUseRaw(checked)}
            disabled={readOnly || mode === "ignore"}
            aria-label="Use raw JSON editor"
          />
          <Label
            htmlFor={`${modeId}-raw`}
            className="text-[11px] text-muted-foreground"
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
          argProperties={argProperties}
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
  argProperties,
  readOnly,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: ArgMatchMode;
  argProperties?: Record<string, any>;
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
              argProperties={argProperties}
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
  argProperties,
  readOnly,
  isKeyTaken,
  onCommitKey,
  onChangeValue,
  onRemove,
}: {
  persistedKey: string;
  value: unknown;
  mode: ArgMatchMode;
  argProperties?: Record<string, any>;
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

  // When the selected tool exposes an input schema, offer the argument name
  // as a dropdown (parity with the tool dropdown) instead of free text. The
  // JSON-schema entry for the current key also feeds value type hints into
  // the leaf picker. Tools without a schema fall back to the free-text input.
  const argKeys = argProperties ? Object.keys(argProperties) : [];
  const useKeyDropdown = argKeys.length > 0;
  const argSchema = argProperties?.[persistedKey] as
    | { type?: string; description?: string }
    | undefined;
  // A freshly-added row uses a synthetic `arg`/`argN` key that isn't a real
  // schema property — show the placeholder so the user is prompted to pick.
  const isPlaceholderKey =
    /^arg\d*$/.test(persistedKey) && !argKeys.includes(persistedKey);
  const keyItems = argKeys
    // Hide names already used by sibling rows so the dropdown can't create a
    // collision; keep the current row's own key selectable.
    .filter((k) => k === persistedKey || !isKeyTaken(k))
    .map((k) => {
      const schema = argProperties![k] as
        | { type?: string; description?: string }
        | undefined;
      let description = schema?.description || "";
      if (schema?.type) {
        description += description
          ? ` (Type: ${schema.type})`
          : `Type: ${schema.type}`;
      }
      return { value: k, label: k, description };
    });

  return (
    <li className="space-y-2 rounded-lg border border-border/40 bg-muted/10 p-2.5">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[10px] text-muted-foreground">Argument</Label>
          {!readOnly ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label={`Remove argument ${persistedKey}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {useKeyDropdown ? (
          <Combobox
            items={keyItems}
            value={isPlaceholderKey ? "" : persistedKey}
            onValueChange={(newKey) => onCommitKey(newKey)}
            placeholder="Select arg…"
            searchPlaceholder="Search arguments…"
            emptyMessage="No arguments"
            className="h-8 w-full justify-between font-mono text-xs"
          />
        ) : (
          <>
            <Input
              value={draftKey}
              onChange={(e) => {
                const candidate = e.target.value;
                setDraftKey(candidate);
                if (candidate === persistedKey) return;
                if (candidate.length === 0) return;
                if (isKeyTaken(candidate)) return;
                onCommitKey(candidate);
              }}
              placeholder="key"
              className={cn(
                "h-8 w-full font-mono text-xs",
                (collides || isEmpty) &&
                  "border-destructive focus-visible:ring-destructive",
              )}
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
              <span className="text-[10px] text-destructive">
                Key already exists
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <Label className="text-[10px] text-muted-foreground">
          Expected value
        </Label>
        <ArgLeafPicker
          value={value}
          onChange={(next) => onChangeValue(next)}
          argumentMatching={mode}
          inferredType={argSchema?.type}
          inputPlaceholder={argSchema?.type ? `${argSchema.type}` : undefined}
          disabled={readOnly}
          className="w-full"
        />
      </div>
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
  compact = false,
}: {
  predicate: Extract<Predicate, { type: "tokenBudgetUnder" }>;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
  compact?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {compact ? "Max tokens" : "Max tokens (strictly under)"}
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
  /** Append scenario predicates to steps (parent writes steps + strips global list). */
  onAppendScenarioToSteps?: (scenarioAsserts: Predicate[]) => void;
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
  onAppendScenarioToSteps,
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
    const { scenarioAsserts: caseScenarioAsserts } =
      splitPredicatesForMigration(caseList);
    const { scenarioAsserts: suiteScenarioAsserts } =
      splitPredicatesForMigration(suiteDefaults);
    return (
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-1 min-w-0">
            <h4 className="text-xs font-medium text-foreground">Global gates</h4>
            <GlobalGatesSectionInfoHint />
          </div>
          <AddCheckMenu
            globalGatesMenu
            onAdd={(kind) =>
              setEmbeddedList([...caseList, blankPredicate(kind)])
            }
          />
        </div>
        {suiteScenarioAsserts.length > 0 ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            Suite defaults include {suiteScenarioAsserts.length} scenario check
            {suiteScenarioAsserts.length === 1 ? "" : "s"} — review in Suite
            settings.
          </p>
        ) : null}
        {caseScenarioAsserts.length > 0 ? (
          <div className="rounded-md border border-border/50 bg-muted/20 p-2.5 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              {caseScenarioAsserts.length} scenario check
              {caseScenarioAsserts.length === 1 ? "" : "s"} here — move to
              Steps for inline checks.
            </p>
            {onAppendScenarioToSteps ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  onAppendScenarioToSteps(caseScenarioAsserts);
                  setEmbeddedList(stripScenarioPredicatesFromList(caseList));
                }}
              >
                Move to Steps (append at end)
              </Button>
            ) : null}
          </div>
        ) : null}
        {inheritedCount > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            +{inheritedCount} from suite
          </p>
        ) : !hasOwnChecks ? (
          <p className="text-[11px] italic text-muted-foreground">
            None on this case yet
          </p>
        ) : null}
        {hasOwnChecks ? (
          <ChecksSection
            title=""
            hideAddButton
            hideEmptyState
            globalGatesMenu
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
