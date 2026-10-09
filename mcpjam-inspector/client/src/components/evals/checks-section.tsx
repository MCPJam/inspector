import { Checkbox } from "@mcpjam/design-system/checkbox";
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

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";
import { Trash2, Plus, X } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import { ArgLeafPicker } from "./arg-leaf-picker";
import type {
  Predicate,
  ArgMatchMode,
  CasePredicates,
} from "@/shared/eval-matching";
import {
  MATCH_PATTERN_FLAGS,
  matchBoundsError,
  matchPathError,
  matchPathFromKey,
  matchPatternError,
  MAX_MATCH_PATH_CHARS,
  MAX_MATCH_PATTERN_CHARS,
  MAX_MATCH_PATTERNS,
  parseMatchPath,
  predicateSchema,
  type MatchPatternFlags,
  type MatchUnit,
} from "@mcpjam/sdk/predicates";
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
import { toolNameWarning } from "./tool-name-warning";
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
  /**
   * Per-tool output-schema properties, for the output pattern check's field
   * picker. Only tools that declare an output schema appear; the rest get
   * free text.
   */
  toolOutputSchemas?: ToolArgSchemas;
  /** Header label override. */
  title?: string;
  /** Subtitle/explainer. */
  description?: string;
  /**
   * Empty-state copy override. The default speaks eval-suite language
   * ("every case passes by default") — surfaces where checks observe rather
   * than gate (swarm rubrics) pass their own sentence.
   */
  emptyStateText?: string;
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
  /**
   * What one row is CALLED on this surface, for the Add placeholder and the
   * Remove label. Two vocabularies share this editor: the eval surfaces say
   * "assertion" (the pinned word), and swarm rubrics still say "check". The
   * default keeps a caller that says nothing on the word it has today.
   */
  noun?: string;
  /**
   * Fires when the section starts or stops holding a raw-JSON draft that does
   * not parse. Such a draft is deliberately never written into a predicate (a
   * half-typed schema is not an assertion), so `areAllChecksValid` cannot see
   * it: the row still holds the last args that parsed, and Zod accepts those.
   * Callers that gate Save on validity combine this with that check.
   *
   * Optional and inert when absent — the registry still runs, but nothing
   * downstream reads it.
   */
  onDraftValidityChange?: (hasInvalidDraft: boolean) => void;
  /**
   * Show every row's validation issues, touched or not. Callers turn this on
   * when the user tries to save with an incomplete check — see `CheckRow`.
   */
  showAllErrors?: boolean;
}

/**
 * Where the raw-JSON editors report an unparsable draft, keyed by editor
 * instance rather than row index: a row deleted or reordered above unmounts
 * or re-keys the editor, and the registration follows the instance.
 */
const InvalidDraftRegistry = createContext<
  ((editorId: string, invalid: boolean) => void) | null
>(null);

export function useInvalidDraftRegistration(invalid: boolean): void {
  const report = useContext(InvalidDraftRegistry);
  const editorId = useId();
  useEffect(() => {
    report?.(editorId, invalid);
    return () => report?.(editorId, false);
  }, [report, editorId, invalid]);
}

/** Invalid local text must block Save even though it has not replaced the last valid value. */
export function CheckDraftBoundary({
  children,
  onValidityChange,
}: {
  children: ReactNode;
  onValidityChange?: (invalid: boolean) => void;
}) {
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const report = useCallback((id: string, invalid: boolean) => {
    setInvalidIds((previous) => {
      if (previous.has(id) === invalid) return previous;
      const next = new Set(previous);
      if (invalid) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const invalid = invalidIds.size > 0;
  useEffect(() => {
    onValidityChange?.(invalid);
  }, [invalid, onValidityChange]);
  useEffect(() => () => onValidityChange?.(false), [onValidityChange]);
  return (
    <InvalidDraftRegistry.Provider value={report}>
      {children}
    </InvalidDraftRegistry.Provider>
  );
}

/**
 * How a `CheckRow` hands its Zod verdict to the fields inside it.
 *
 * A blank check fails the schema before anyone has typed — eight kinds start
 * with a required string empty — and painting that on first render made a
 * fresh row look broken. So an issue is SHOWN only once its field has been
 * touched, or when the caller asks for everything (a Save attempt). The field
 * owns the copy: "Pick a tool" says what to do, where Zod's message says what
 * went wrong with a string.
 */
interface FieldValidation {
  /** Whether the current predicate has a Zod issue at this top-level path. */
  isInvalid: (path: string) => boolean;
  /** Whether an issue at this path should be visible right now. */
  isShown: (path: string) => boolean;
  markTouched: (path: string) => void;
}

const FieldValidationContext = createContext<FieldValidation | null>(null);

/**
 * Paths whose issue a field renders itself, with its own copy. Any other
 * issue falls back to the row-level line. Static rather than registered:
 * the row renders before its fields, so it could not learn the claims of
 * the same pass any other way.
 */
const FIELD_OWNED_PATHS: ReadonlySet<string> = new Set([
  "toolName",
  "beforeToolName",
  "needle",
  "pattern",
  // `toolInputMatches` / `toolResultMatches`: one issue path covers every
  // pattern row, so the rows say which one is wrong; the count fields word
  // their own bounds, and the path field its own pointer.
  "patterns",
  "path",
  "min",
  "max",
]);

function useFieldValidation(
  path: string,
  message: string,
): { error: string | null; markTouched: () => void } {
  const ctx = useContext(FieldValidationContext);
  const error =
    ctx && ctx.isInvalid(path) && ctx.isShown(path) ? message : null;
  const markTouched = useCallback(() => ctx?.markTouched(path), [ctx, path]);
  return { error, markTouched };
}

export function ChecksSection({
  value,
  onChange,
  availableTools,
  toolArgSchemas,
  toolOutputSchemas,
  title = "Default checks",
  description,
  emptyStateText,
  readOnly = false,
  hideAddButton = false,
  hideEmptyState = false,
  allowedKinds,
  globalGatesMenu = false,
  noun = "check",
  onDraftValidityChange,
  showAllErrors = false,
}: ChecksSectionProps & { hideAddButton?: boolean; hideEmptyState?: boolean }) {
  const [invalidDraftIds, setInvalidDraftIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const reportDraft = useMemo(
    () => (editorId: string, invalid: boolean) => {
      setInvalidDraftIds((prev) => {
        if (prev.has(editorId) === invalid) return prev;
        const next = new Set(prev);
        if (invalid) next.add(editorId);
        else next.delete(editorId);
        return next;
      });
    },
    [],
  );
  const hasInvalidDraft = invalidDraftIds.size > 0;
  useEffect(() => {
    onDraftValidityChange?.(hasInvalidDraft);
    // Only the boolean: an inline callback would otherwise re-fire on every
    // render with the same answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInvalidDraft]);

  // One stable key per row, so React keeps each `CheckRow` instance — and the
  // textarea drafts and touched state inside it — with ITS predicate when a
  // row above is removed. Predicates carry no id, and keying by index handed
  // row 2's editor to row 3's predicate on every delete. Kept in a ref, not
  // state: the list is aligned to `value` in render and spliced in the same
  // handler that splices `value`, so nothing needs to re-render because of it.
  const rowKeys = useRef<string[]>([]);
  const mintedRows = useRef(0);
  const mintRowKey = () => `row-${(mintedRows.current += 1)}`;
  while (rowKeys.current.length < value.length) {
    rowKeys.current.push(mintRowKey());
  }
  if (rowKeys.current.length > value.length) {
    rowKeys.current.length = value.length;
  }

  const updateAt = (index: number, next: Predicate) => {
    const copy = value.slice();
    copy[index] = next;
    onChange(copy);
  };
  const removeAt = (index: number) => {
    const copy = value.slice();
    copy.splice(index, 1);
    rowKeys.current.splice(index, 1);
    onChange(copy);
  };
  const addOfKind = (kind: Kind) => {
    rowKeys.current.push(mintRowKey());
    onChange([...value, blankPredicate(kind)]);
  };

  const showHeader = Boolean(title) || Boolean(description);
  return (
    <InvalidDraftRegistry.Provider value={reportDraft}>
      <div className="space-y-3">
        {showHeader ? (
          <div>
            {title ? (
              <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            ) : null}
            {description ? (
              <p className="text-xs text-muted-foreground mt-1">
                {description}
              </p>
            ) : null}
          </div>
        ) : null}

        {value.length === 0 ? (
          hideEmptyState ? null : (
            <p className="text-xs italic text-muted-foreground/70">
              {emptyStateText ??
                `No checks set${
                  !readOnly ? " — every case passes by default." : "."
                }`}
            </p>
          )
        ) : (
          <ul className="space-y-2">
            {value.map((predicate, i) => (
              <li key={rowKeys.current[i]}>
                <CheckRow
                  predicate={predicate}
                  onChange={
                    readOnly ||
                    (globalGatesMenu && isScenarioPredicateKind(predicate.type))
                      ? () => {}
                      : (next) => updateAt(i, next)
                  }
                  onRemove={
                    readOnly ||
                    (globalGatesMenu && isScenarioPredicateKind(predicate.type))
                      ? undefined
                      : () => removeAt(i)
                  }
                  availableTools={availableTools}
                  toolArgSchemas={toolArgSchemas}
                  toolOutputSchemas={toolOutputSchemas}
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
                  showAllErrors={showAllErrors}
                  noun={noun}
                />
              </li>
            ))}
          </ul>
        )}

        {!readOnly && !hideAddButton ? (
          <AddCheckMenu
            onAdd={addOfKind}
            allowedKinds={
              globalGatesMenu ? GLOBAL_POLICY_MENU_KINDS : allowedKinds
            }
            globalGatesMenu={globalGatesMenu}
            noun={noun}
          />
        ) : null}
      </div>
    </InvalidDraftRegistry.Provider>
  );
}

export function AddCheckMenu({
  onAdd,
  allowedKinds,
  globalGatesMenu = false,
  noun = "check",
}: {
  onAdd: (kind: Predicate["type"]) => void;
  /** When set, restrict the menu to these kinds. */
  allowedKinds?: readonly Predicate["type"][];
  globalGatesMenu?: boolean;
  /** @see ChecksSectionProps.noun */
  noun?: string;
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
          <SelectValue placeholder={`Add ${noun}…`} />
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
  /**
   * Names for the widget-filter dropdowns (`widgetRendered`,
   * `widgetRenderLatencyUnder`, `widgetNoConsoleErrors`). Defaults to
   * `availableTools`; callers whose `availableTools` include harness system
   * tools (bash, read, …) pass the MCP-only subset here — system tools never
   * render widgets.
   */
  widgetToolNames?: string[];
  toolArgSchemas?: ToolArgSchemas;
  /** @see ChecksSectionProps.toolOutputSchemas */
  toolOutputSchemas?: ToolArgSchemas;
  readOnly?: boolean;
  /** Strip outer card chrome + kind header when nested in a step or the scorer table. */
  embedded?: boolean;
  /** Scenario predicate still in Global gates list — prompt move to steps. */
  legacyScenarioGate?: boolean;
  /** Compact whole-run gate row (label + hint in header, minimal fields). */
  globalGate?: boolean;
  /** @see ChecksSectionProps.noun */
  noun?: string;
  /** Reveal issues on untouched fields too — the Save-attempt case. */
  showAllErrors?: boolean;
  /** Paper manual-case field layout; other authoring surfaces keep their layout. */
  paper?: boolean;
}

const PaperFieldsContext = createContext<Predicate["type"] | null>(null);

export function CheckRow({
  predicate,
  onChange,
  onRemove,
  availableTools,
  widgetToolNames,
  toolArgSchemas,
  toolOutputSchemas,
  readOnly = false,
  embedded = false,
  legacyScenarioGate = false,
  globalGate = false,
  noun = "check",
  showAllErrors = false,
  paper = false,
}: CheckRowProps) {
  // Zod-validate the current row. Callers gate Save on the same schema via
  // `areAllChecksValid`; this copy of the verdict is what the fields show,
  // and only once touched — see `FieldValidation`.
  const issues = useMemo(() => {
    const result = predicateSchema.safeParse(predicate);
    const byPath = new Map<string, string>();
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = String(issue.path[0] ?? "");
        if (!byPath.has(path)) byPath.set(path, issue.message);
      }
    }
    return byPath;
  }, [predicate]);

  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const markTouched = useCallback((path: string) => {
    setTouched((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);
  const isShown = useCallback(
    (path: string) => showAllErrors || touched.has(path),
    [showAllErrors, touched],
  );
  const fieldValidation = useMemo<FieldValidation>(
    () => ({
      isInvalid: (path) => issues.has(path),
      isShown,
      markTouched,
    }),
    [issues, isShown, markTouched],
  );

  // Issues no field renders itself. Zod's own wording, since we know nothing
  // more specific about them. Shown as soon as they exist, NOT behind the
  // touched gate: a blank check only ever fails on the field-owned paths
  // (see `blankPredicate`), so an issue here means the user typed something —
  // a zero into a count that must be positive — and hiding it would leave a
  // disabled Save with no explanation in the editors that never turn on
  // `showAllErrors`.
  const rowLevelError = useMemo(() => {
    const rest = [...issues.entries()]
      .filter(([path]) => !FIELD_OWNED_PATHS.has(path))
      .map(([, message]) => message);
    return rest.length > 0 ? rest.join("; ") : null;
  }, [issues]);
  const showRowLevelError = rowLevelError !== null;
  const anyErrorShown =
    showRowLevelError ||
    [...issues.keys()].some(
      (path) => FIELD_OWNED_PATHS.has(path) && isShown(path),
    );

  return (
    <div
      className={cn(
        embedded
          ? cn(
              "min-w-0 space-y-3",
              paper &&
                "text-card-foreground [&_label]:text-sm [&_label]:font-medium",
            )
          : cn(
              "rounded-md border p-3",
              anyErrorShown
                ? "border-destructive/40 bg-destructive/5"
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

          <FieldValidationContext.Provider value={fieldValidation}>
            <PaperFieldsContext.Provider value={paper ? predicate.type : null}>
              <CheckFields
                predicate={predicate}
                onChange={onChange}
                availableTools={availableTools}
                widgetToolNames={widgetToolNames}
                toolArgSchemas={toolArgSchemas}
                toolOutputSchemas={toolOutputSchemas}
                readOnly={readOnly}
                compactGlobalGate={globalGate}
              />
            </PaperFieldsContext.Provider>
          </FieldValidationContext.Provider>

          {showRowLevelError ? (
            // An alert: it appears in direct response to the keystroke that
            // caused it, and the number inputs it speaks for carry no
            // aria-describedby to it.
            <div role="alert" className="text-[11px] text-destructive">
              {rowLevelError}
            </div>
          ) : null}
          {legacyScenarioGate ? (
            <p className="text-[11px] text-muted-foreground">
              Scenario {noun} — use Move to Steps to edit inline in the flow.
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
            aria-label={`Remove ${noun}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The allowed set for `onlyToolsCalled`.
 *
 * An EMPTY set is a real claim — "no tool should be called" — not an unset
 * state, so the row says which one it is rather than leaving a blank list to
 * be read either way.
 */
function OnlyToolsField({
  value,
  onChange,
  availableTools,
  readOnly,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const paper = useContext(PaperFieldsContext);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toolName, setToolName] = useState("");
  const options = (availableTools ?? []).filter(
    (tool) => !value.includes(tool),
  );
  const addTool = () => {
    const name = toolName.trim();
    if (!readOnly && name && !value.includes(name)) {
      onChange([...value, name]);
      setToolName("");
    }
  };
  if (paper)
    return (
      <div className="space-y-2">
        {value.length ? (
          <ul className="flex flex-wrap gap-1">
            {value.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  disabled={readOnly}
                  aria-label={`Remove ${name}`}
                  onClick={() =>
                    onChange(value.filter((tool) => tool !== name))
                  }
                  className="rounded-full border border-border px-2 py-0.5 text-[11px]"
                >
                  {name}
                  {readOnly ? null : (
                    <X aria-hidden className="ml-1 inline size-3" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No tool should be called.
          </p>
        )}
        {!readOnly ? (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs">
                Add a tool
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1">
              <Input
                aria-label="Find or enter a tool"
                value={toolName}
                onChange={(event) => setToolName(event.target.value)}
                placeholder="Tool name"
                className="h-8 text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !availableTools?.length) {
                    event.preventDefault();
                    addTool();
                    setPickerOpen(false);
                  }
                }}
              />
              {availableTools?.length ? (
                <div className="max-h-48 overflow-auto">
                  {options
                    .filter((name) =>
                      name.toLowerCase().includes(toolName.toLowerCase()),
                    )
                    .map((name) => (
                      <Button
                        key={name}
                        variant="ghost"
                        className="h-8 w-full justify-start text-xs"
                        onClick={() => {
                          onChange([...value, name]);
                          setToolName("");
                          setPickerOpen(false);
                        }}
                      >
                        {name}
                      </Button>
                    ))}
                  {options.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      All tools have been added.
                    </p>
                  ) : null}
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="h-8 text-xs"
                  disabled={!toolName.trim() || value.includes(toolName.trim())}
                  onClick={() => {
                    addTool();
                    setPickerOpen(false);
                  }}
                >
                  Add a tool
                </Button>
              )}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    );
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {value.length === 0
          ? "No tool should be called."
          : "Any tool outside this list fails the check."}
      </p>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {value.map((tool) => (
            <li key={tool}>
              <button
                type="button"
                disabled={readOnly}
                aria-label={`Remove ${tool}`}
                onClick={() => onChange(value.filter((t) => t !== tool))}
                className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
              >
                {tool}
                {readOnly ? null : <span aria-hidden>×</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!readOnly && !availableTools?.length ? (
        <div className="flex items-center gap-1.5">
          <Input
            aria-label="Allowed tool name"
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTool();
              }
            }}
            className="h-7 text-xs"
            placeholder="Tool name"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!toolName.trim() || value.includes(toolName.trim())}
            onClick={addTool}
          >
            Allow tool
          </Button>
        </div>
      ) : null}
      {readOnly || options.length === 0 ? null : (
        <select
          aria-label="Allow another tool"
          value=""
          onChange={(event) => {
            if (event.target.value) onChange([...value, event.target.value]);
          }}
          className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs"
        >
          <option value="">Allow another tool…</option>
          {options.map((tool) => (
            <option key={tool} value={tool}>
              {tool}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const PAPER_CHECK_SENTENCES: Partial<Record<Predicate["type"], string>> = {
  toolNamesUnique: "Passes when tool names are unique within each server.",
  noDeprecatedToolExposed:
    "Warns when a tool description marks itself deprecated.",
  toolInputSchemasWellFormed:
    "Passes when input schemas have an object root and documented parameters.",
  toolOutputSchemasPresent: "Passes when every tool declares an output schema.",
  finalAssistantMessageNonEmpty: "Passes when the final reply contains text.",
  noDeprecatedToolCalled: "Warns when a tool marked deprecated is called.",
  noDestructiveToolCalled: "Passes when no tool marked destructive is called.",
};

function CheckFields({
  predicate,
  onChange,
  availableTools,
  widgetToolNames,
  toolArgSchemas,
  toolOutputSchemas,
  readOnly,
  compactGlobalGate = false,
}: {
  predicate: Predicate;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  widgetToolNames?: string[];
  toolArgSchemas?: ToolArgSchemas;
  toolOutputSchemas?: ToolArgSchemas;
  readOnly: boolean;
  compactGlobalGate?: boolean;
}) {
  const widgetTools = widgetToolNames ?? availableTools;
  const paper = useContext(PaperFieldsContext);
  const sentence = PAPER_CHECK_SENTENCES[predicate.type];
  if (paper && sentence)
    return (
      <p className="text-xs text-secondary-foreground dark:text-muted-foreground">
        {sentence}
      </p>
    );
  if (
    paper &&
    (predicate.type === "tokenBudgetUnder" ||
      predicate.type === "turnCountUnder")
  ) {
    const field = predicate.type === "tokenBudgetUnder" ? "tokens" : "turns";
    return (
      <PaperNumberField
        value={
          predicate.type === "tokenBudgetUnder"
            ? predicate.tokens
            : predicate.turns
        }
        unit={field === "tokens" ? "tokens" : "user turns"}
        readOnly={readOnly}
        onChange={(number) =>
          onChange({ ...predicate, [field]: number } as Predicate)
        }
      />
    );
  }
  switch (predicate.type) {
    case "toolDescriptionsPresent":
      if (paper)
        return (
          <div className="space-y-1">
            <div className="text-sm font-medium">
              Minimum description length
            </div>
            <PaperNumberField
              value={predicate.minLength ?? 20}
              ariaLabel="Minimum description length"
              unit="characters"
              readOnly={readOnly}
              onChange={(minLength) => {
                if (minLength > 0) onChange({ ...predicate, minLength });
              }}
            />
          </div>
        );
      return (
        <label className="text-xs">
          Minimum description length
          <Input
            type="number"
            min={1}
            step={1}
            value={predicate.minLength ?? 20}
            disabled={readOnly}
            onChange={(event) => {
              const minLength = Number(event.target.value);
              if (Number.isInteger(minLength) && minLength > 0)
                onChange({ ...predicate, minLength });
            }}
          />
        </label>
      );
    case "toolAnnotationsPresent": {
      const fields = (
        <div className="space-y-2 text-xs">
          Require boolean annotations (leave both off to check presence only):
          {(["readOnlyHint", "destructiveHint"] as const).map((key) => (
            <label key={key} className="flex items-center gap-2">
              <Checkbox
                checked={predicate.require?.includes(key) ?? false}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  onChange({
                    ...predicate,
                    require: checked
                      ? [
                          ...(predicate.require ?? []).filter(
                            (item) => item !== key,
                          ),
                          key,
                        ]
                      : (predicate.require ?? []).filter(
                          (item) => item !== key,
                        ),
                  })
                }
              />
              {key}
            </label>
          ))}
        </div>
      );
      return paper ? (
        <div className="space-y-2">
          <p className="text-xs text-secondary-foreground dark:text-muted-foreground">
            Passes when every tool declares annotations.
          </p>
          <details className="text-xs text-card-foreground">
            <summary className="cursor-pointer">Annotation settings</summary>
            <div className="pt-2">{fields}</div>
          </details>
        </div>
      ) : (
        fields
      );
    }
    case "toolNamesUnique":
    case "noDeprecatedToolExposed":
    case "toolInputSchemasWellFormed":
    case "toolOutputSchemasPresent":
      return (
        <p className="text-xs text-muted-foreground">
          Evaluated over a complete raw catalog. Missing or partial capture is
          reported as an evaluator error.
        </p>
      );

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
    case "onlyToolsCalled":
      // Present everywhere a check can be READ, so a case authored on the
      // Evaluate spine still edits correctly if it is opened on /evals. Where
      // it can be ADDED is narrower — see `spineLibraryKinds`.
      return (
        <OnlyToolsField
          value={predicate.toolNames}
          onChange={(toolNames) => onChange({ ...predicate, toolNames })}
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
    case "responseCloseTo":
      return (
        <ResponseCloseToFields
          predicate={predicate}
          onChange={onChange}
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
    case "toolLatencyUnder":
      return (
        <ToolResultNumberFields
          predicate={predicate}
          field="ms"
          label="Max time in ms (strictly under)"
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "toolResultSizeUnder":
      return (
        <ToolResultNumberFields
          predicate={predicate}
          field="maxBytes"
          label="Max result size in bytes (strictly under)"
          hint="Measured on what the server returned, before we cap the text we store. Bytes, not tokens — a budget has to be graded on a measurement."
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "toolResultContains":
      return (
        <ToolResultContainsFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "toolResultMatchesSchema":
      return (
        <ToolResultSchemaFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "noEndingQuestion":
      return (
        <div className="text-xs text-muted-foreground">
          {paper ? (
            "Passes when the reply does not end in a question."
          ) : (
            <>
              Notices answers whose last non-empty line ends with a question
              mark. It cannot tell an offer ("Would you like a breakdown?") from
              a request for something missing, so it reports what it saw and
              never fails an iteration.
            </>
          )}
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
    case "turnCountUnder":
      return (
        <TurnCountField
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
            Passes when at least one MCP App view rendered during the iteration.
            Fails when the run recorded no view renders.
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
            availableTools={widgetTools}
            readOnly={readOnly}
          />
        </div>
      );
    case "widgetRenderLatencyUnder":
      return (
        <WidgetLatencyFields
          predicate={predicate}
          onChange={onChange}
          availableTools={widgetTools}
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
            availableTools={widgetTools}
            readOnly={readOnly}
          />
        );
      }
      return (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Passes when no rendered widget logged console errors. Fails when the
            run recorded no widget renders.
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
            availableTools={widgetTools}
            readOnly={readOnly}
          />
        </div>
      );
    case "toolErrorNamesInput":
      return (
        <ObservationFields
          predicate={predicate}
          copy="Notices a tool error whose message names none of that tool's input keys and none of the values the call sent. It does not measure recovery quality — \u201cRate limited. Retry in 30 seconds.\u201d is a good message that names nothing."
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "fullPageHasContinuation":
      return (
        <ObservationFields
          predicate={predicate}
          copy="Notices a page whose length equals the limit it asked for and that carries no cursor, hasMore or similar. A full page is not proof that more results exist, so this reports rather than fails."
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "noRepeatedIdenticalCall":
      return (
        <ObservationFields
          predicate={predicate}
          copy="Notices a call repeated immediately after an identical one \u2014 same tool, same arguments. A poll loop and a retry after a transient failure are the same shape and both are correct, so this reports rather than fails."
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "argumentsMatchToolSchema":
      return (
        <ObservationFields
          predicate={predicate}
          copy="Validates every call's arguments against the tool's declared inputSchema, and names which rule broke. Valid arguments can still miss what the user asked for \u2014 this does not judge intent. Reports an error, not a failure, when the run captured no tool inventory."
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "toolInputMatches":
    case "toolResultMatches":
      return (
        <PatternMatchFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          pathSchemas={
            predicate.type === "toolInputMatches"
              ? toolArgSchemas
              : toolOutputSchemas
          }
          readOnly={readOnly}
        />
      );
    case "toolCallCountUnder":
      return (
        <ToolResultNumberFields
          predicate={predicate}
          field="count"
          label="Max tool calls (strictly under)"
          hint="Total calls, which is not the same as calls before the right tool. A server that forces a lookup before a write spends hops the model did not choose."
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "toolCalledBefore":
      return (
        <ToolOrderFields
          predicate={predicate}
          onChange={onChange}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      );
    case "noDeprecatedToolCalled":
      return (
        <div className="text-xs text-muted-foreground">
          Notices a call to a tool whose own description marks it deprecated
          (&ldquo;[DEPRECATED]&rdquo;, &ldquo;use X instead&rdquo;). It reads
          prose, so it reports rather than fails; a tool that merely mentions a
          deprecated predecessor does not count.
        </div>
      );
    case "noDestructiveToolCalled":
      return (
        <div className="text-xs text-muted-foreground">
          Passes when no called tool declares{" "}
          <code>annotations.destructiveHint</code>. You assert the prompt is
          read-only by adding this check; the server&rsquo;s own annotation
          decides the rest. Reports an error when no tool declares annotations
          at all &mdash; nothing was stated, so nothing can be checked.
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
  label = "Tool",
  compact = false,
  path = "toolName",
}: {
  value: string;
  onChange: (next: string) => void;
  availableTools?: string[];
  readOnly: boolean;
  /**
   * What this control is FOR, when a row carries more than one of them.
   * `toolCalledBefore` renders two, and two fields both labelled "Tool" are
   * indistinguishable to a screen reader — which is the whole of that rule's
   * UI. The outer heading is not enough: it is not associated with the input.
   */
  label?: string;
  compact?: boolean;
  /**
   * Which predicate field this control edits, for validation. Defaults to
   * `toolName`; the ordering rule's second field is `beforeToolName`.
   */
  path?: "toolName" | "beforeToolName";
}) {
  const id = useId();
  const paper = useContext(PaperFieldsContext);
  const inline =
    paper &&
    ["toolCalledAtLeastOnce", "toolNeverCalled", "firstToolWas"].includes(
      paper,
    );
  const errorId = `${id}-error`;
  // When a suite has attached servers and we know the tool list, prefer a
  // dropdown to prevent typos. Fall back to free text otherwise (legacy
  // suites without an attached server, or for tools the editor doesn't
  // know about yet).
  const useDropdown = availableTools && availableTools.length > 0;
  const { error, markTouched } = useFieldValidation(
    path,
    useDropdown ? "Pick a tool" : "Enter a tool name",
  );
  const warningId = `${id}-warning`;
  const warning = error
    ? undefined
    : toolNameWarning(value, useDropdown ? availableTools : undefined);
  // A saved name the list does not carry must still read as itself: an
  // empty trigger would present a broken assertion as an unset one.
  const unlistedValue =
    useDropdown && value && !availableTools!.includes(value) ? value : null;
  return (
    <div
      className={
        inline
          ? "flex flex-wrap items-center gap-2"
          : compact
            ? "grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 pr-7"
            : "space-y-1"
      }
    >
      <Label htmlFor={id} className="text-[11px]">
        {label}
      </Label>
      {useDropdown && !readOnly ? (
        <Select
          value={value || undefined}
          onValueChange={(next) => {
            markTouched();
            onChange(next);
          }}
          // Closing the menu without choosing is the dropdown's blur.
          onOpenChange={(open) => {
            if (!open) markTouched();
          }}
        >
          <SelectTrigger
            id={id}
            className={
              inline
                ? "h-7 w-auto min-w-24 text-xs"
                : paper
                  ? "h-9 w-full text-sm"
                  : compact
                    ? "h-7 w-full border-0 bg-transparent font-mono text-xs shadow-none"
                    : "h-8 text-xs"
            }
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : warning ? warningId : undefined}
          >
            <SelectValue placeholder="Pick a tool…" />
          </SelectTrigger>
          <SelectContent>
            {unlistedValue ? (
              <SelectItem value={unlistedValue} className="text-xs">
                {unlistedValue}
              </SelectItem>
            ) : null}
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
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : warning ? warningId : undefined}
          onChange={(e) => {
            markTouched();
            onChange(e.target.value);
          }}
          onBlur={markTouched}
          placeholder="Tool name"
          className={
            inline
              ? "h-7 w-40 text-xs"
              : paper
                ? "h-9 text-sm"
                : "h-8 text-xs"
          }
          disabled={readOnly}
        />
      )}
      {error ? (
        <p
          id={errorId}
          className={cn(
            "text-[11px] text-destructive",
            compact && "col-start-2",
          )}
        >
          {error}
        </p>
      ) : warning ? (
        <p
          id={warningId}
          className={cn("text-[11px] text-warning", compact && "col-start-2")}
        >
          {warning}
        </p>
      ) : null}
    </div>
  );
}

function CompactFieldDetails({
  compact,
  open,
  label,
  children,
}: {
  compact: boolean;
  open: boolean;
  label: string;
  children: ReactNode;
}) {
  if (!compact) return <>{children}</>;
  return (
    <details open={open} className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer py-1">{label}</summary>
      {children}
    </details>
  );
}

export function ToolCalledWithFields({
  predicate,
  onChange,
  availableTools,
  toolArgSchemas,
  readOnly,
  compact = false,
  paper = false,
}: {
  predicate: Extract<Predicate, { type: "toolCalledWith" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  toolArgSchemas?: ToolArgSchemas;
  readOnly: boolean;
  compact?: boolean;
  paper?: boolean;
}) {
  const minCountId = useId();
  // Schema properties for the currently-selected tool, if known. Drives the
  // argument-name dropdown + value type hints below; empty/undefined falls
  // back to free-text keys.
  const argProperties = toolArgSchemas?.[predicate.toolName];
  const contextPaper = useContext(PaperFieldsContext);
  const minimumMatchingCalls = (
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
  );
  if (paper || contextPaper)
    return (
      <PaperFieldsContext.Provider value="toolCalledWith">
        <div className="space-y-2">
          <ToolNameField
            value={predicate.toolName}
            onChange={(toolName) => onChange({ ...predicate, toolName })}
            availableTools={availableTools}
            readOnly={readOnly}
          />
          {predicate.args.argumentMatching === "ignore" ? (
            <p className="text-xs text-muted-foreground">
              Arguments are ignored.
            </p>
          ) : (
            <RawArgsJsonEditor
              paper
              value={predicate.args.args ?? {}}
              mode={predicate.args.argumentMatching ?? "partial"}
              readOnly={readOnly}
              onChange={(args) =>
                onChange({ ...predicate, args: { ...predicate.args, args } })
              }
            />
          )}
          <details className="text-xs text-card-foreground">
            <summary className="cursor-pointer">Argument settings</summary>
            <div className="space-y-3 pt-2">
              <ArgumentMatchingField
                value={predicate.args.argumentMatching ?? "partial"}
                onChange={(argumentMatching) =>
                  onChange({
                    ...predicate,
                    args: { ...predicate.args, argumentMatching },
                  })
                }
                readOnly={readOnly}
              />
              <div className="space-y-1">
                <Label htmlFor={minCountId} className="text-sm font-medium">
                  Minimum matching calls (optional)
                </Label>
                <PaperNumberField
                  id={minCountId}
                  ariaLabel="Minimum matching calls (optional)"
                  value={predicate.minCount}
                  placeholder="1"
                  unit="calls"
                  readOnly={readOnly}
                  onChange={(minCount) => onChange({ ...predicate, minCount })}
                  onClear={() => {
                    const next = { ...predicate };
                    delete next.minCount;
                    onChange(next);
                  }}
                />
              </div>
            </div>
          </details>
        </div>
      </PaperFieldsContext.Provider>
    );
  return (
    <div className={compact ? "space-y-1" : "space-y-3"}>
      <ToolNameField
        compact={compact}
        value={predicate.toolName}
        onChange={(toolName) => onChange({ ...predicate, toolName })}
        availableTools={availableTools}
        readOnly={readOnly}
      />
      <CompactFieldDetails
        compact={compact}
        open={Object.keys(predicate.args.args ?? {}).length > 0}
        label={`Arguments · ${predicate.args.argumentMatching ?? "partial"} matching`}
      >
        <ArgMatcherSubform
          value={predicate.args}
          onChange={(args) => onChange({ ...predicate, args })}
          argProperties={argProperties}
          readOnly={readOnly}
        />
      </CompactFieldDetails>
      <CompactFieldDetails
        compact={compact}
        open={predicate.minCount != null}
        label={`Call count${predicate.minCount != null ? ` · ${predicate.minCount}` : ""}`}
      >
        {minimumMatchingCalls}
      </CompactFieldDetails>
    </div>
  );
}

/** True iff `v` is a nested JSON container (object or array). The
 *  structured per-leaf editor handles only flat top-level keys; nested
 *  shapes fall back to the raw JSON view so users can author them
 *  without a tree-builder. */
function isNestedContainer(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  return (
    Array.isArray(v) || Object.keys(v as Record<string, unknown>).length > 0
  );
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

function ArgumentMatchingField({
  value,
  onChange,
  readOnly,
}: {
  value: ArgMatchMode;
  onChange: (next: ArgMatchMode) => void;
  readOnly: boolean;
}) {
  const modeId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={modeId} className="text-[11px]">
        Argument matching
      </Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as ArgMatchMode)}
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
  );
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
        <ArgumentMatchingField
          value={mode}
          onChange={(argumentMatching) =>
            onChange({ ...value, argumentMatching })
          }
          readOnly={readOnly}
        />
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
    { type?: string; description?: string } | undefined;
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
        { type?: string; description?: string } | undefined;
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
function parseArgsDraft(text: string): {
  parsed: Record<string, unknown> | null;
  error: string | null;
} {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { parsed: null, error: "Expected a JSON object" };
    }
    return { parsed: parsed as Record<string, unknown>, error: null };
  } catch (err) {
    return {
      parsed: null,
      error: err instanceof Error ? err.message : "Invalid JSON",
    };
  }
}

function RawArgsJsonEditor({
  value,
  onChange,
  mode,
  readOnly,
  paper = false,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: ArgMatchMode;
  readOnly: boolean;
  paper?: boolean;
}) {
  const argsId = useId();
  const formatValue = (v: unknown): string => {
    try {
      return paper ? JSON.stringify(v ?? {}) : JSON.stringify(v ?? {}, null, 2);
    } catch {
      return "{}";
    }
  };
  // The draft remembers which `value` it is the text FOR. When the prop
  // arrives from somewhere other than this textarea's own last parse — the
  // whole list replaced on a scenario switch, say — the text is re-derived in
  // render rather than one effect-tick later. A row removed or reordered
  // above no longer reaches here at all: `ChecksSection` keys rows stably, so
  // that remounts the editor with its own predicate.
  const valueKey = JSON.stringify(value ?? {});
  const [draft, setDraft] = useState(() => ({
    text: formatValue(value),
    forValue: valueKey,
  }));
  if (draft.forValue !== valueKey) {
    setDraft({ text: formatValue(value), forValue: valueKey });
  }
  const draftJson =
    draft.forValue === valueKey ? draft.text : formatValue(value);
  // Derived from the text, never stored beside it: a stored flag is one more
  // thing an unrelated edit can leave stale, and this one gates Save.
  const jsonError = useMemo(() => parseArgsDraft(draftJson).error, [draftJson]);
  useInvalidDraftRegistration(jsonError !== null);

  return (
    <div className="space-y-1">
      <Label htmlFor={argsId} className="text-[11px]">
        {paper ? "Arguments" : "Expected args (JSON)"}
        {!paper && mode === "partial" ? (
          <span className="ml-2 text-muted-foreground font-normal">
            Placeholders allowed: "string", "number", "boolean", "object",
            "array", "null", "any"
          </span>
        ) : null}
      </Label>
      <Textarea
        id={argsId}
        rows={paper ? 1 : undefined}
        aria-invalid={jsonError ? true : undefined}
        className={
          paper
            ? "min-h-9 h-9 resize-y border-input px-3 py-2 font-sans text-sm md:text-sm"
            : `min-h-[80px] w-full rounded-md border bg-background p-2 font-mono text-[11px] leading-tight ${
                jsonError ? "border-destructive/60" : "border-border/60"
              }`
        }
        value={draftJson}
        onChange={(e) => {
          const next = e.target.value;
          const { parsed } = parseArgsDraft(next);
          // A parse that fails keeps pointing at the value already shown, so
          // the text survives the re-render; one that succeeds points at the
          // value it is about to become.
          setDraft({
            text: next,
            forValue: parsed ? JSON.stringify(parsed) : valueKey,
          });
          if (parsed) onChange(parsed);
        }}
        spellCheck={false}
        disabled={readOnly}
      />
      {jsonError ? (
        <div className="text-[11px] text-destructive">{jsonError}</div>
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
  const paper = useContext(PaperFieldsContext);
  const needleId = useId();
  const csId = useId();
  const { error, markTouched } = useFieldValidation(
    "needle",
    "Enter the text to look for",
  );
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={needleId} className="text-[11px]">
          {paper ? "Text" : "Needle"}
        </Label>
        <Input
          id={needleId}
          value={predicate.needle}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${needleId}-error` : undefined}
          onChange={(e) => {
            markTouched();
            onChange({ ...predicate, needle: e.target.value });
          }}
          onBlur={markTouched}
          placeholder="e.g. refund issued"
          className={paper ? "h-9 text-sm" : "h-8 text-xs"}
          disabled={readOnly}
        />
        {error ? (
          <p id={`${needleId}-error`} className="text-[11px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {paper ? null : (
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
      )}
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
  const paper = useContext(PaperFieldsContext);
  // Live-validate the regex on input. An invalid pattern shows inline as soon
  // as it is typed — the user wrote it, so it is not an untouched-field
  // message. The empty case goes through the touched rule like every other
  // required field. We don't attempt to detect ReDoS here — the evaluator has
  // its own heuristic guard.
  let regexError: string | null = null;
  if (predicate.pattern) {
    try {
      new RegExp(predicate.pattern);
    } catch (e) {
      regexError = e instanceof Error ? e.message : "Invalid regex";
    }
  }
  const { error: emptyError, markTouched } = useFieldValidation(
    "pattern",
    "Enter a pattern",
  );
  const error = regexError ?? emptyError;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {paper ? "Pattern" : "Regex pattern (no surrounding slashes)"}
      </Label>
      <Input
        id={id}
        value={predicate.pattern}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => {
          markTouched();
          onChange({ ...predicate, pattern: e.target.value });
        }}
        onBlur={markTouched}
        placeholder="e.g. ^Order #\\d{4} confirmed$"
        className={paper ? "h-9 text-sm" : "h-8 font-mono text-xs"}
        disabled={readOnly}
      />
      {error ? (
        <div id={`${id}-error`} className="text-[11px] text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}

type PatternMatchPredicate = Extract<
  Predicate,
  { type: "toolInputMatches" | "toolResultMatches" }
>;

/** The flag letters, in the one order the wire accepts. */
const PATTERN_FLAG_LETTERS = ["i", "m", "s"] as const;
type PatternFlagLetter = (typeof PATTERN_FLAG_LETTERS)[number];

/**
 * The flag string for a set of letters — `"im"`, never `"mi"` — or
 * `undefined` for none. Looked up in the closed list, so a spelling the
 * schema refuses cannot be written.
 */
function patternFlagsOf(
  letters: ReadonlySet<PatternFlagLetter>,
): MatchPatternFlags | undefined {
  const spelled = PATTERN_FLAG_LETTERS.filter((l) => letters.has(l)).join("");
  return MATCH_PATTERN_FLAGS.find((flags) => flags === spelled);
}

/**
 * The words that differ between the two pattern checks. Everything else —
 * the pattern list, the flags, the bounds rule — is one control, and the unit
 * (`"call"` or `"result"`) fills in the rest.
 */
const PATTERN_MATCH_COPY: Record<
  MatchUnit,
  {
    pathLabel: string;
    whole: string;
    placeholders: readonly [string, string];
    /** What `0/0` does NOT mean, after "not that". */
    notZero: string;
  }
> = {
  call: {
    pathLabel: "Argument",
    whole: "Whole input",
    placeholders: ["e.g. Idea", "e.g. Build|Ship"],
    notZero: "the tool was never called",
  },
  result: {
    pathLabel: "Field",
    whole: "Whole output",
    placeholders: ["e.g. ISS-\\d+", "e.g. open|closed"],
    notZero: "the tool returned nothing",
  },
};

/**
 * A re2js compile error in words an author can act on. re2js is linear-time,
 * so it has no lookaround and no backreferences — the two JavaScript idioms
 * someone is most likely to type, and the two its own message names worst.
 */
function patternErrorCopy(error: string, unit: MatchUnit): string {
  if (/`\(\?<?[=!]/.test(error)) {
    return `Lookahead and lookbehind aren't supported. To require two things in the same ${unit}, add another pattern.`;
  }
  if (/invalid escape sequence: `\\[1-9]/.test(error)) {
    return "Backreferences like \\1 aren't supported.";
  }
  return `Not a valid pattern: ${error.replace(/^error parsing regexp: /, "")}`;
}

/**
 * What one pattern row shows: the compile error as typed, a stored pattern
 * over the cap, or — only once touched — that it is empty.
 */
function patternRowError(
  pattern: string,
  compileError: string | undefined,
  emptyError: string | null,
  unit: MatchUnit,
): string | null {
  if (compileError !== undefined) return patternErrorCopy(compileError, unit);
  if (pattern.length > MAX_MATCH_PATTERN_CHARS) {
    return `At most ${MAX_MATCH_PATTERN_CHARS} characters`;
  }
  return pattern === "" ? emptyError : null;
}

/**
 * Why a stored `path` cannot be saved, in words about the KEY the author sees.
 *
 * A typed key always becomes a well-formed pointer — `matchPathFromKey`
 * escapes every `/` and `~` — so the one fault typing can reach is length,
 * where each escape counts twice. Anything else is a row another writer
 * stored, and `matchPathError` says what is wrong with it as it stands.
 */
function matchPathErrorCopy(path: string): string | null {
  const error = matchPathError(path);
  if (error === undefined) return null;
  if (path.length > MAX_MATCH_PATH_CHARS) {
    const most = MAX_MATCH_PATH_CHARS - 1;
    return `At most ${most} characters; a "/" or "~" in the name counts as two.`;
  }
  return error;
}

/**
 * Which top-level key the patterns read, or the whole input or output.
 *
 * The author picks or types the KEY and sees the key; the predicate stores
 * the one-key JSON Pointer `matchPathFromKey` spells for it (`elements` →
 * `/elements`, `a/b` → `/a~1b`). The pointer is a storage detail: nobody
 * should need to know that a `/` inside a key is written `~1`.
 */
function MatchPathField({
  path,
  onChange,
  keys,
  label,
  wholeLabel,
  readOnly,
}: {
  path: string | undefined;
  onChange: (next: string | undefined) => void;
  /** Keys from the chosen tool's schema; empty means free text. */
  keys: string[];
  label: string;
  wholeLabel: string;
  readOnly: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const parsed = path === undefined ? undefined : parseMatchPath(path);
  // A stored pointer that does not parse is shown as stored, beside why,
  // rather than decoded into a key it does not name.
  const shown =
    parsed === undefined ? undefined : parsed.ok ? parsed.key : path;
  const error = path === undefined ? null : matchPathErrorCopy(path);
  const setKey = (key: string | undefined) =>
    onChange(
      key === undefined || key === "" ? undefined : matchPathFromKey(key),
    );
  // Same encoding as `ResultToolFilterField`: the sentinel is unprefixed, so
  // no key — not even one spelled "whole" — can collide with it.
  const WHOLE = "whole";
  const encode = (key: string) => `key:${key}`;
  const decode = (option: string) =>
    option === WHOLE ? undefined : option.slice("key:".length);
  // A saved key the schema no longer lists stays selectable, or the trigger
  // would show nothing for a check that still reads it.
  const names =
    shown !== undefined && !keys.includes(shown) ? [shown, ...keys] : keys;
  const usePicker = keys.length > 0 && !readOnly && parsed?.ok !== false;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {label}
      </Label>
      {usePicker ? (
        <Select
          value={shown === undefined ? WHOLE : encode(shown)}
          onValueChange={(next) => setKey(decode(next))}
        >
          <SelectTrigger
            id={id}
            className="h-8 text-xs"
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WHOLE} className="text-xs">
              {wholeLabel}
            </SelectItem>
            {names.map((name) => (
              <SelectItem
                key={name}
                value={encode(name)}
                className="font-mono text-xs"
              >
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={shown ?? ""}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          maxLength={MAX_MATCH_PATH_CHARS - 1}
          onChange={(e) => setKey(e.target.value)}
          placeholder={wholeLabel}
          className="h-8 font-mono text-xs"
          disabled={readOnly}
        />
      )}
      {error ? (
        <p id={errorId} className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `toolInputMatches` and `toolResultMatches`: what went INTO a call, or what
 * came back in a result, checked with patterns. One editor, because the two
 * share every rule but their unit — a call, or a result — and their tool
 * field: input names the tool it reads, output may read any tool's results.
 *
 * The everyday fields are the tool, the path, the pattern list and Ignore
 * case; the other two flags and the count sit behind "More options", because
 * the default — at least one call (or result) matches every pattern — is what
 * almost every author means.
 *
 * Every edit goes through `update`, which DROPS an optional field the author
 * emptied rather than writing its default: the predicate is the criterion's
 * identity, so `min: 1` beside an omitted `min` would be two ids for one
 * check.
 */
export function PatternMatchFields({
  predicate,
  onChange,
  availableTools,
  pathSchemas,
  readOnly,
}: {
  predicate: PatternMatchPredicate;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  /**
   * Per-tool schema `properties` for the path picker: the input schema's for
   * `toolInputMatches`, the declared output schema's for `toolResultMatches`.
   * A tool missing here, or no tool at all, gets free text.
   */
  pathSchemas?: ToolArgSchemas;
  readOnly: boolean;
}) {
  const paper = useContext(PaperFieldsContext);
  const patternsLabelId = useId();
  const patternRowId = useId();
  const ignoreCaseId = useId();
  const multilineId = useId();
  const dotAllId = useId();
  const minId = useId();
  const maxId = useId();
  const unit: MatchUnit =
    predicate.type === "toolInputMatches" ? "call" : "result";
  const copy = PATTERN_MATCH_COPY[unit];
  const patterns = predicate.patterns;
  const flags = predicate.flags;
  const letters = new Set(
    PATTERN_FLAG_LETTERS.filter((letter) => flags?.includes(letter)),
  );
  const [moreOpen, setMoreOpen] = useState(
    () =>
      letters.has("m") ||
      letters.has("s") ||
      (paper && predicate.path !== undefined) ||
      predicate.min !== undefined ||
      predicate.max !== undefined,
  );

  const update = (patch: Partial<PatternMatchPredicate>) => {
    const next: Record<string, unknown> = { ...predicate, ...patch };
    for (const key of ["toolName", "flags", "path", "min", "max"]) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(next as Predicate);
  };
  const setFlag = (letter: PatternFlagLetter, on: boolean) => {
    const next = new Set(letters);
    if (on) next.add(letter);
    else next.delete(letter);
    update({ flags: patternFlagsOf(next) });
  };
  const setPattern = (index: number, pattern: string) =>
    update({ patterns: patterns.map((p, i) => (i === index ? pattern : p)) });
  const setCount = (key: "min" | "max", raw: string) => {
    const n = raw === "" ? undefined : Math.floor(Number(raw));
    if (n !== undefined && (!Number.isFinite(n) || n < 0)) return;
    update(key === "min" ? { min: n } : { max: n });
  };

  const parsedPath =
    predicate.path === undefined ? undefined : parseMatchPath(predicate.path);
  const pathKey = parsedPath?.ok ? parsedPath.key : undefined;
  const setTool = (toolName: string | undefined) => {
    // A key the new tool's schema does not declare would leave every unit
    // "missing" it; a tool with no known schema, or any tool, keeps the key.
    const known = toolName ? pathSchemas?.[toolName] : undefined;
    const keep =
      predicate.path === undefined ||
      !known ||
      (pathKey !== undefined &&
        Object.prototype.hasOwnProperty.call(known, pathKey));
    update({ toolName, path: keep ? predicate.path : undefined });
  };
  const pathKeys = Object.keys(
    (predicate.toolName ? pathSchemas?.[predicate.toolName] : undefined) ?? {},
  );

  // Compiled live, with the flags the evaluator will use: the same call the
  // schema makes, so a row this marks valid is one Save accepts. The schema
  // refuses the predicate too, which is what blocks Save; registering the
  // draft keeps a caller that listens only to `onDraftValidityChange` honest.
  const compileErrors = patterns.map((pattern) =>
    pattern ? matchPatternError(pattern, flags) : undefined,
  );
  useInvalidDraftRegistration(
    !readOnly && compileErrors.some((error) => error !== undefined),
  );
  // An empty row waits for a touch like every other required field; the
  // schema flags it on `patterns`, the path every row shares.
  const { error: emptyError, markTouched } = useFieldValidation(
    "patterns",
    "Enter a pattern",
  );

  // Bounds are worded here, beside the inputs, rather than in the row-level
  // line: the schema only reaches its bounds rule once every other field
  // parses, and "at least 0 on its own" deserves saying while it is typed.
  const bounds = matchBoundsError(predicate.min, predicate.max, unit);
  const countFallback = "Enter a whole number, 0 or more";
  const minIssue = useFieldValidation("min", countFallback).error;
  const maxIssue = useFieldValidation("max", countFallback).error;
  let countError = minIssue ?? maxIssue;
  if (bounds?.path === "min") {
    countError = `"At least 0" needs an "at most" too: on its own it passes every transcript. Set "at most" to 0 for "no ${unit} matches".`;
  } else if (bounds) {
    const floor = predicate.min ?? "1 when left empty";
    countError = `"At most" can't be below "at least" (${floor}).`;
  }

  return (
    <div className="space-y-3">
      {unit === "call" ? (
        <ToolNameField
          value={predicate.toolName ?? ""}
          onChange={setTool}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      ) : (
        <ResultToolFilterField
          label="Tool"
          anyLabel="Any tool"
          value={predicate.toolName}
          onChange={setTool}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      )}
      {!paper ? (
        <MatchPathField
          path={predicate.path}
          onChange={(path) => update({ path })}
          keys={pathKeys}
          label={copy.pathLabel}
          wholeLabel={copy.whole}
          readOnly={readOnly}
        />
      ) : null}
      <div className="space-y-1.5">
        <Label id={patternsLabelId} className="text-[11px]">
          Patterns
        </Label>
        {!paper ? (
          <p className="text-[11px] text-muted-foreground">
            A {unit} passes only if it matches every pattern. Use{" "}
            <code className="font-mono">A|B</code> for either.
          </p>
        ) : null}
        <ul aria-labelledby={patternsLabelId} className="space-y-1.5">
          {patterns.map((pattern, index) => {
            const rowId = `${patternRowId}-${index}`;
            const error = patternRowError(
              pattern,
              compileErrors[index],
              emptyError,
              unit,
            );
            return (
              // Index keys are safe: a row holds no state of its own, so a
              // removal above only moves values, never a draft.
              <li key={index} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Input
                    id={rowId}
                    value={pattern}
                    aria-label={`Pattern ${index + 1}`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${rowId}-error` : undefined}
                    maxLength={MAX_MATCH_PATTERN_CHARS}
                    onChange={(e) => {
                      markTouched();
                      setPattern(index, e.target.value);
                    }}
                    onBlur={markTouched}
                    placeholder={copy.placeholders[index === 0 ? 0 : 1]}
                    className={paper ? "h-9 text-sm" : "h-8 font-mono text-xs"}
                    disabled={readOnly}
                  />
                  {readOnly ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        update({
                          patterns: patterns.filter((_, i) => i !== index),
                        })
                      }
                      disabled={patterns.length <= 1}
                      aria-label={`Remove pattern ${index + 1}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {error ? (
                  <p
                    id={`${rowId}-error`}
                    className="text-[11px] text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {patterns.length > MAX_MATCH_PATTERNS ? (
          <p className="text-[11px] text-destructive">
            At most {MAX_MATCH_PATTERNS} patterns.
          </p>
        ) : null}
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => update({ patterns: [...patterns, ""] })}
            disabled={patterns.length >= MAX_MATCH_PATTERNS}
          >
            <Plus className="h-3.5 w-3.5" />
            Add pattern
          </Button>
        )}
      </div>
      {!paper ? (
        <div className="flex items-center gap-2">
          <Switch
            id={ignoreCaseId}
            checked={letters.has("i")}
            onCheckedChange={(on) => setFlag("i", on)}
            disabled={readOnly}
          />
          <Label htmlFor={ignoreCaseId} className="text-[11px]">
            Ignore case
          </Label>
        </div>
      ) : null}
      <details
        open={moreOpen}
        onToggle={(event) =>
          setMoreOpen((event.currentTarget as HTMLDetailsElement).open)
        }
        className={
          paper
            ? "text-[11px] text-card-foreground"
            : "text-[11px] text-muted-foreground"
        }
      >
        <summary className="cursor-pointer py-1">More options</summary>
        <div className="mt-2 space-y-3">
          {paper ? (
            <>
              <MatchPathField
                path={predicate.path}
                onChange={(path) => update({ path })}
                keys={pathKeys}
                label={copy.pathLabel}
                wholeLabel={copy.whole}
                readOnly={readOnly}
              />
              <p className="text-[11px] text-muted-foreground">
                A {unit} passes only if it matches every pattern. Use{" "}
                <code className="font-mono">A|B</code> for either.
              </p>
              <div className="flex items-center gap-2">
                <Switch
                  id={ignoreCaseId}
                  checked={letters.has("i")}
                  onCheckedChange={(on) => setFlag("i", on)}
                  disabled={readOnly}
                />
                <Label htmlFor={ignoreCaseId} className="text-[11px]">
                  Ignore case
                </Label>
              </div>
            </>
          ) : null}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id={multilineId}
                checked={letters.has("m")}
                onCheckedChange={(on) => setFlag("m", on)}
                disabled={readOnly}
              />
              <Label htmlFor={multilineId} className="text-[11px]">
                <code className="font-mono">^</code> and{" "}
                <code className="font-mono">$</code> match at line breaks
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={dotAllId}
                checked={letters.has("s")}
                onCheckedChange={(on) => setFlag("s", on)}
                disabled={readOnly}
              />
              <Label htmlFor={dotAllId} className="text-[11px]">
                <code className="font-mono">.</code> matches line breaks
              </Label>
            </div>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-medium text-foreground">
              Matching {unit}s
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={minId} className="text-[11px]">
                At least
              </Label>
              <Input
                id={minId}
                type="number"
                min={0}
                step={1}
                value={predicate.min ?? ""}
                aria-invalid={countError ? true : undefined}
                onChange={(e) => setCount("min", e.target.value)}
                placeholder="1"
                className={paper ? "h-6 w-12 px-2 text-xs" : "h-8 w-20 text-xs"}
                disabled={readOnly}
              />
              <Label htmlFor={maxId} className="text-[11px]">
                At most
              </Label>
              <Input
                id={maxId}
                type="number"
                min={0}
                step={1}
                value={predicate.max ?? ""}
                aria-invalid={countError ? true : undefined}
                onChange={(e) => setCount("max", e.target.value)}
                placeholder="No limit"
                className={paper ? "h-6 w-20 px-2 text-xs" : "h-8 w-24 text-xs"}
                disabled={readOnly}
              />
            </div>
            <p>
              Counts only {unit}s that match every pattern, not all {unit}s. At
              least 0 and at most 0 means no {unit} matches. It does not mean{" "}
              {copy.notZero}.
            </p>
            {countError ? (
              <p role="alert" className="text-destructive">
                {countError}
              </p>
            ) : null}
          </fieldset>
        </div>
      </details>
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
  const paper = useContext(PaperFieldsContext);
  const ALL = "__all__";
  const useDropdown = availableTools && availableTools.length > 0;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {paper ? "View" : "Limit to tool (optional)"}
      </Label>
      {useDropdown && !readOnly ? (
        <Select
          value={value ?? ALL}
          onValueChange={(next) => onChange(next === ALL ? undefined : next)}
        >
          <SelectTrigger
            id={id}
            className={paper ? "h-9 text-sm" : "h-8 text-xs"}
          >
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
          className={paper ? "h-9 text-sm" : "h-8 text-xs"}
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
  const paper = useContext(PaperFieldsContext);
  if (paper)
    return (
      <div className="space-y-2">
        <PaperNumberField
          value={predicate.ms}
          unit="ms"
          readOnly={readOnly}
          onChange={(ms) => onChange({ ...predicate, ms })}
        />
        <details className="text-xs text-card-foreground">
          <summary className="cursor-pointer">View filter</summary>
          <WidgetToolFilterField
            value={predicate.toolName}
            onChange={(toolName) => onChange(withToolName(predicate, toolName))}
            availableTools={availableTools}
            readOnly={readOnly}
          />
        </details>
      </div>
    );
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

/**
 * "Limit to tool (optional)", for the result-shaped checks.
 *
 * A separate component from `WidgetToolFilterField` only because its empty
 * option says "All tools" rather than "All widgets" — the same control would
 * otherwise tell an author their payload budget applies to widgets.
 */
function ResultToolFilterField({
  value,
  onChange,
  availableTools,
  readOnly,
  label = "Limit to tool (optional)",
  anyLabel = "All tools",
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  availableTools?: string[];
  readOnly: boolean;
  /**
   * What this control is FOR, when the row uses more than one of them. Two
   * fields both labelled "Limit to tool" are indistinguishable to a screen
   * reader, which is the whole of the ordering rule's UI.
   */
  label?: string;
  /** The no-filter choice, e.g. "Any tool" where one matching result is enough. */
  anyLabel?: string;
}) {
  const paper = useContext(PaperFieldsContext);
  const id = useId();
  // The all-tools option and a real tool name live in ONE value space, so the
  // sentinel must be unreachable by any tool name rather than merely unlikely:
  // a server with a tool called `__all__` would otherwise clear the
  // restriction when a reader selected it. Real names are prefixed; the
  // sentinel is not, so no encoding of a name can collide with it.
  const ALL = "all";
  const encode = (toolName: string) => `tool:${toolName}`;
  const decode = (option: string) =>
    option === ALL ? undefined : option.slice("tool:".length);
  const useDropdown = availableTools && availableTools.length > 0;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {label}
      </Label>
      {useDropdown && !readOnly ? (
        <Select
          value={value === undefined ? ALL : encode(value)}
          onValueChange={(next) => onChange(decode(next))}
        >
          <SelectTrigger
            id={id}
            className={paper ? "h-9 text-sm" : "h-8 text-xs"}
            aria-label={label}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              {anyLabel}
            </SelectItem>
            {value && !availableTools!.includes(value) ? (
              <SelectItem value={encode(value)}>{value}</SelectItem>
            ) : null}
            {availableTools!.map((t) => (
              <SelectItem key={t} value={encode(t)} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value ?? ""}
          aria-label={label}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : e.target.value)
          }
          placeholder={anyLabel}
          className={paper ? "h-9 text-sm" : "h-8 text-xs"}
          disabled={readOnly}
        />
      )}
    </div>
  );
}

/** A description plus the optional tool filter, for the fieldless kinds. */
function ObservationFields<
  P extends Extract<
    Predicate,
    {
      type:
        | "toolErrorNamesInput"
        | "fullPageHasContinuation"
        | "noRepeatedIdenticalCall"
        | "argumentsMatchToolSchema";
    }
  >,
>({
  predicate,
  copy,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: P;
  copy: string;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const paper = useContext(PaperFieldsContext);
  const filter = (
    <ResultToolFilterField
      value={predicate.toolName}
      onChange={(toolName) => onChange(withToolName(predicate, toolName))}
      availableTools={availableTools}
      readOnly={readOnly}
    />
  );
  if (paper) {
    const sentences = {
      argumentsMatchToolSchema:
        "Passes when tool arguments match their declared schema.",
      noRepeatedIdenticalCall:
        "Warns when the same tool is called twice in a row with identical arguments.",
      toolErrorNamesInput:
        "Warns when a tool error names none of its input keys or values.",
      fullPageHasContinuation:
        "Warns when a full result page has no continuation metadata.",
    };
    return (
      <div className="space-y-2">
        <p className="text-xs text-secondary-foreground dark:text-muted-foreground">
          {sentences[predicate.type]}
        </p>
        <details className="text-xs text-card-foreground">
          <summary className="cursor-pointer">Tool filter</summary>
          <div className="space-y-2 pt-2">
            {filter}
            <p>{copy}</p>
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">{copy}</div>
      {filter}
    </div>
  );
}

/** The two tool names an ordering rule constrains. */
function ToolOrderFields({
  predicate,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "toolCalledBefore" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const paper = useContext(PaperFieldsContext);
  return (
    <div className="space-y-2">
      <ToolNameField
        label={paper ? "First tool" : "Must be called first"}
        value={predicate.toolName}
        onChange={(toolName) => onChange({ ...predicate, toolName })}
        availableTools={availableTools}
        readOnly={readOnly}
      />
      <ToolNameField
        label={paper ? "Second tool" : "Before this tool"}
        path="beforeToolName"
        value={predicate.beforeToolName}
        onChange={(beforeToolName) =>
          onChange({ ...predicate, beforeToolName })
        }
        availableTools={availableTools}
        readOnly={readOnly}
      />
      <p className="text-[11px] text-muted-foreground">
        Vacuously true when the second tool is never called &mdash; the rule has
        nothing to violate.
      </p>
    </div>
  );
}

/** Set `toolName`, or remove it — an empty string would filter to nothing. */
function withToolName<T extends { toolName?: string }>(
  predicate: T,
  toolName: string | undefined,
): T {
  const next = { ...predicate };
  if (toolName === undefined) delete next.toolName;
  else next.toolName = toolName;
  return next;
}

/** A positive-integer ceiling plus the optional tool filter. */
function ToolResultNumberFields<
  P extends Extract<
    Predicate,
    { type: "toolLatencyUnder" | "toolResultSizeUnder" | "toolCallCountUnder" }
  >,
>({
  predicate,
  field,
  label,
  hint,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: P;
  field: "ms" | "maxBytes" | "count";
  label: string;
  hint?: string;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const paper = useContext(PaperFieldsContext);
  const id = useId();
  const value = (predicate as Record<string, unknown>)[field] as number;
  if (paper)
    return (
      <div className="space-y-2">
        {field !== "count" ? (
          <ResultToolFilterField
            value={predicate.toolName}
            onChange={(toolName) => onChange(withToolName(predicate, toolName))}
            availableTools={availableTools}
            readOnly={readOnly}
            label="Tool"
          />
        ) : null}
        <PaperNumberField
          value={value}
          prefix={field === "count" ? undefined : "Under"}
          unit={
            field === "ms"
              ? "ms"
              : field === "maxBytes"
                ? "bytes"
                : "tool calls"
          }
          readOnly={readOnly}
          onChange={(number) =>
            onChange({ ...predicate, [field]: number } as Predicate)
          }
        />
        {field === "count" ? (
          <details className="text-xs text-card-foreground">
            <summary className="cursor-pointer">Tool filter</summary>
            <ResultToolFilterField
              value={predicate.toolName}
              onChange={(toolName) =>
                onChange(withToolName(predicate, toolName))
              }
              availableTools={availableTools}
              readOnly={readOnly}
            />
          </details>
        ) : null}
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={id} className="text-[11px]">
          {label}
        </Label>
        <Input
          id={id}
          type="number"
          min={1}
          step={1}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange({ ...predicate, [field]: Math.floor(n) } as Predicate);
          }}
          className="h-8 w-40 text-xs"
          disabled={readOnly}
        />
        {hint ? (
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <ResultToolFilterField
        value={predicate.toolName}
        onChange={(toolName) => onChange(withToolName(predicate, toolName))}
        availableTools={availableTools}
        readOnly={readOnly}
      />
    </div>
  );
}

function ToolResultContainsFields({
  predicate,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "toolResultContains" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const id = useId();
  const paper = useContext(PaperFieldsContext);
  const { error, markTouched } = useFieldValidation(
    "needle",
    "Enter the text the result must contain",
  );
  return (
    <div className="space-y-2">
      {paper ? (
        <ResultToolFilterField
          label="Tool"
          value={predicate.toolName}
          onChange={(toolName) => onChange(withToolName(predicate, toolName))}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={id} className="text-[11px]">
          {paper ? "Text" : "Text the result must contain"}
        </Label>
        <Input
          id={id}
          value={predicate.needle}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            markTouched();
            onChange({ ...predicate, needle: e.target.value });
          }}
          onBlur={markTouched}
          placeholder="ISS-4412"
          className={paper ? "h-9 text-sm" : "h-8 text-xs"}
          disabled={readOnly}
        />
        {error ? (
          <p id={`${id}-error`} className="text-[11px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {!paper ? (
        <ResultToolFilterField
          value={predicate.toolName}
          onChange={(toolName) => onChange(withToolName(predicate, toolName))}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      ) : null}
    </div>
  );
}

/**
 * Identity of a schema value for the draft's "which value am I the text
 * for" check. `undefined` gets its own sentinel: `JSON.stringify(undefined)`
 * is not a string, and folding it into `{}` would hide a real move from
 * unset to `{}`. Only malformed stored data can be `undefined` here — the SDK
 * type requires `schema` — so the sentinel is a guard, not a code path the
 * editor itself produces.
 */
function schemaKeyOf(schema: unknown): string {
  return schema === undefined ? "\u0000undefined" : JSON.stringify(schema);
}

function parseSchemaDraft(
  text: string,
):
  | { ok: true; parsed: unknown; error: null }
  | { ok: false; parsed: null; error: string } {
  try {
    return { ok: true, parsed: JSON.parse(text), error: null };
  } catch (parseError) {
    return {
      ok: false,
      parsed: null,
      error:
        parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
}

function ToolResultSchemaFields({
  predicate,
  onChange,
  availableTools,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "toolResultMatchesSchema" }>;
  onChange: (next: Predicate) => void;
  availableTools?: string[];
  readOnly: boolean;
}) {
  const id = useId();
  const paper = useContext(PaperFieldsContext);
  // Same draft model as `RawArgsJsonEditor`: the text knows which schema it is
  // for, and is re-derived in render when the schema arrives from outside.
  // The identity comes from ONE function in all three places (initial state,
  // the render-phase check, the write-through). Any JSON root is legal here,
  // null included, so the key must not fold null into {} while the value
  // written is null — that made the box snap back to {} over a stored null.
  const schemaKey = schemaKeyOf(predicate.schema);
  // The undefined branch is required, not defensive: JSON.stringify(undefined)
  // is not a string. Everything else, null included, renders as itself.
  const formatSchema = () =>
    predicate.schema === undefined
      ? "{}"
      : JSON.stringify(predicate.schema, null, paper ? undefined : 2);
  const [draftState, setDraftState] = useState(() => ({
    text: formatSchema(),
    forSchema: schemaKey,
  }));
  if (draftState.forSchema !== schemaKey) {
    setDraftState({ text: formatSchema(), forSchema: schemaKey });
  }
  const draft =
    draftState.forSchema === schemaKey ? draftState.text : formatSchema();
  // Derived from the text — see `RawArgsJsonEditor`.
  const error = useMemo(() => parseSchemaDraft(draft).error, [draft]);
  useInvalidDraftRegistration(error !== null);
  return (
    <div className="space-y-2">
      {paper ? (
        <ResultToolFilterField
          label="Tool"
          value={predicate.toolName}
          onChange={(toolName) => onChange(withToolName(predicate, toolName))}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={id} className="text-[11px]">
          {paper ? "Schema" : "JSON Schema the result must match"}
        </Label>
        <Textarea
          id={id}
          value={draft}
          spellCheck={false}
          rows={paper ? 1 : 6}
          onChange={(e) => {
            const next = e.target.value;
            const { parsed, ok } = parseSchemaDraft(next);
            setDraftState({
              text: next,
              forSchema: ok ? schemaKeyOf(parsed) : schemaKey,
            });
            // Written through only when it parses: a half-typed schema is not
            // an assertion, and persisting one would make the check
            // unusable-schema on the next run. The row meanwhile HOLDS the
            // last schema that parsed, so the message below says so, and the
            // section reports the unparsable draft upward so a caller can
            // keep Save closed until it parses again.
            if (ok) onChange({ ...predicate, schema: parsed });
          }}
          className={
            paper
              ? "h-9 min-h-9 resize-y font-sans text-sm md:text-sm"
              : "font-mono text-xs"
          }
          disabled={readOnly}
        />
        {error ? (
          <p className="text-[11px] text-destructive">
            Not valid JSON: {error}. Saving now keeps the last schema that
            parsed, not what is in the box.
          </p>
        ) : !paper ? (
          <p className="text-[11px] text-muted-foreground">
            Validated against the tool's structured content, then its JSON
            output, then text that parses as JSON. Any JSON root — an array is
            legal under protocol 2026-07-28.
          </p>
        ) : null}
      </div>
      {!paper ? (
        <ResultToolFilterField
          value={predicate.toolName}
          onChange={(toolName) => onChange(withToolName(predicate, toolName))}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      ) : null}
    </div>
  );
}

function PaperNumberField({
  value,
  onChange,
  onClear,
  unit,
  prefix,
  readOnly,
  id: fieldId,
  ariaLabel,
  placeholder,
}: {
  value: number | undefined;
  onChange: (next: number) => void;
  onClear?: () => void;
  unit: string;
  prefix?: string;
  readOnly: boolean;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const generatedId = useId();
  const id = fieldId ?? generatedId;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[18px] text-card-foreground">
      {prefix ? (
        <Label htmlFor={id} className="text-[13px] font-medium">
          {prefix}
        </Label>
      ) : null}
      <Input
        id={id}
        aria-label={ariaLabel ?? `Strictly under (${unit})`}
        type="number"
        min={1}
        step={1}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(event) => {
          if (event.target.value === "" && onClear) {
            onClear();
            return;
          }
          const number = Number(event.target.value);
          if (Number.isFinite(number)) onChange(Math.floor(number));
        }}
        disabled={readOnly}
        className="h-6 min-w-10 shrink-0 appearance-none px-2 py-1 text-xs leading-4 md:text-xs [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        style={{
          width: Math.max(
            prefix ? 48 : 40,
            String(value ?? placeholder ?? "").length * 8 + 16,
          ),
        }}
      />
      <label htmlFor={id}>{unit}</label>
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

function TurnCountField({
  predicate,
  onChange,
  readOnly,
  compact = false,
}: {
  predicate: Extract<Predicate, { type: "turnCountUnder" }>;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
  compact?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {/* Strictly under, like the token budget: `3` passes at 2 turns and
            fails at 3. The label says so rather than leaving the author to
            discover it from a failing run. */}
        {/* Never "Max": `turnCountUnder: 3` FAILS at exactly 3, and a label
            reading "max 3" would promise the opposite. */}
        {compact ? "Fewer than N user turns" : "User turns (strictly under)"}
      </Label>
      <Input
        id={id}
        type="number"
        min={1}
        step={1}
        value={predicate.turns}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange({ ...predicate, turns: Math.floor(n) });
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
   * When embedded, the inherited "no checks" notice also demotes to muted
   * inline text rather than the warning palette: in the embedded surface, the
   * suite-has-no-checks-and-case-inherits state is the boring default, not an
   * alarm.
   */
  embedded?: boolean;
  emptyInheritanceMessage?: string;
  /** Append scenario predicates to steps (parent writes steps + strips global list). */
  onAppendScenarioToSteps?: (scenarioAsserts: Predicate[]) => void;
}

/**
 * Resolve a CasePredicates view-model with a default (`inherit`) when
 * undefined, so the 3-state radio always has a checked value to bind to.
 */
function resolveCaseChecks(value: CasePredicates | undefined): CasePredicates {
  return value ?? { mode: "inherit", list: [] };
}

export function CaseChecksSection({
  value,
  onChange,
  suiteDefaults,
  availableTools,
  embedded = false,
  emptyInheritanceMessage,
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
            <h4 className="text-xs font-medium text-foreground">
              Whole-run assertions
            </h4>
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
          <p className="text-[11px] text-warning">
            Suite defaults include {suiteScenarioAsserts.length} scenario
            assertion{suiteScenarioAsserts.length === 1 ? "" : "s"} — review in
            Suite settings.
          </p>
        ) : null}
        {caseScenarioAsserts.length > 0 ? (
          <div className="rounded-md border border-border/50 bg-muted/20 p-2.5 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              {caseScenarioAsserts.length} scenario assertion
              {caseScenarioAsserts.length === 1 ? "" : "s"} here — move to Steps
              for inline assertions.
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
            noun="assertion"
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
    mode === "replace" ? "replace" : mode === "extend" ? "extend" : undefined;
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
          Checks for this case. Inherit, replace, or extend the suite&apos;s
          default checks.
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
          emptyInheritanceMessage ? (
            <p className="text-xs text-muted-foreground">
              {emptyInheritanceMessage}
            </p>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-xs text-foreground">
              <span aria-hidden className="mt-0.5 text-warning">
                ⚠
              </span>
              <span>
                Suite has no default assertions. This case has{" "}
                <strong className="font-semibold">no assertions</strong> — it
                will always pass on the assertions axis. Switch to Replace or
                Extend to author case-specific assertions.
              </span>
            </div>
          )
        ) : (
          <div className="rounded-md border border-border/40 bg-background p-3 text-xs text-muted-foreground">
            {`${suiteDefaults.length} assertion${suiteDefaults.length === 1 ? "" : "s"} inherited from suite — view defaults on the suite settings page.`}
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
            noun="assertion"
            readOnly
          />
        </div>
      ) : null}

      {mode === "replace" || mode === "extend" ? (
        <ChecksSection
          value={resolved.list}
          onChange={setList}
          availableTools={availableTools}
          noun="assertion"
          title={
            mode === "extend"
              ? "Additional assertions for this case"
              : "Assertions for this case"
          }
          // In extend mode the inherited suite assertions still run, so the
          // default "every case passes by default" would be false — an empty
          // list here means no EXTRA assertions, not none.
          emptyStateText={
            mode === "extend" && suiteDefaults.length > 0
              ? "No additional assertions on this case."
              : undefined
          }
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

function ResponseCloseToFields({
  predicate,
  onChange,
  readOnly,
}: {
  predicate: Extract<Predicate, { type: "responseCloseTo" }>;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
}) {
  const paper = useContext(PaperFieldsContext);
  const referenceId = useId();
  const distanceId = useId();
  const caseId = useId();
  const whitespaceId = useId();
  const settings = (
    <div className="space-y-2">
      <Label htmlFor={distanceId}>Maximum text distance (0–1)</Label>
      <Input
        id={distanceId}
        className={paper ? "h-6 w-16 px-2 text-xs" : undefined}
        type="number"
        min={0}
        max={1}
        step={0.01}
        value={predicate.maxDistance}
        disabled={readOnly}
        onChange={(event) =>
          onChange({ ...predicate, maxDistance: event.target.valueAsNumber })
        }
      />
      <div className="flex items-center gap-2">
        <Switch
          id={caseId}
          checked={predicate.caseSensitive ?? false}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            onChange({ ...predicate, caseSensitive: checked })
          }
        />
        <Label htmlFor={caseId}>Case sensitive</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={whitespaceId}
          checked={predicate.normalizeWhitespace ?? false}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            onChange({ ...predicate, normalizeWhitespace: checked })
          }
        />
        <Label htmlFor={whitespaceId}>Normalize whitespace</Label>
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      <Label htmlFor={referenceId}>Reference response</Label>
      <Input
        id={referenceId}
        className={paper ? "h-9 text-sm" : undefined}
        value={predicate.reference}
        disabled={readOnly}
        onChange={(event) =>
          onChange({ ...predicate, reference: event.target.value })
        }
      />
      {paper ? (
        <details className="text-xs text-card-foreground">
          <summary className="cursor-pointer">Response settings</summary>
          <div className="pt-2">{settings}</div>
        </details>
      ) : (
        settings
      )}
      {!paper ? (
        <p className="text-xs text-muted-foreground">
          Compares characters, not meaning. Zero requires an exact match after
          normalization. Inputs are limited to 100,000 characters. Unequal text
          that needs more than 4 million edit-distance cells is ungradable, not
          a failed assertion; equal prefixes and suffixes do not consume that
          budget.
        </p>
      ) : null}
    </div>
  );
}
