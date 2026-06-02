/**
 * Per-leaf argument value picker for the eval matcher's `partial` mode
 * (Phase 3).
 *
 * Background: the matcher (Phase 1 work) interprets a small set of
 * placeholder STRINGS at the leaves of an args blob as type assertions
 * instead of literal-equality checks. Until Phase 3, users could author
 * these only by typing the literal placeholder string into JSON — easy to
 * fat-finger ("any" vs "Any" vs "anyone"). This picker surfaces them as a
 * dropdown next to (or replacing) the literal value editor.
 *
 * Persisted shape unchanged: a placeholder leaf is the literal string
 * `"string"` / `"number"` / etc. in the JSON tree; the matcher already
 * interprets those when `argumentMatching === "partial"`. No schema
 * change is required.
 *
 * Used in:
 *   - {@link ExpectedToolsEditor} (case's `expectedToolCalls[*].arguments`)
 *   - {@link ArgMatcherSubform} (`toolCalledWith` predicate `args.args`)
 */

import { useId } from "react";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Switch } from "@mcpjam/design-system/switch";
import { PREDICATE_PLACEHOLDER_STRINGS } from "@mcpjam/sdk/predicates";
import { cn } from "@/lib/utils";

/** The 7 placeholder strings interpreted by the matcher in `partial` mode. */
export type Placeholder = (typeof PREDICATE_PLACEHOLDER_STRINGS)[number];

/** Human labels — italicized in the UI to distinguish from literal values. */
const PLACEHOLDER_LABELS: Record<Placeholder, string> = {
  any: "any value",
  string: "any string",
  number: "any number",
  boolean: "any boolean",
  object: "any object",
  array: "any array",
  null: "must be null",
};

/** Set membership test that doesn't widen `value`'s type. */
function isPlaceholder(value: unknown): value is Placeholder {
  return (
    typeof value === "string" &&
    (PREDICATE_PLACEHOLDER_STRINGS as readonly string[]).includes(value)
  );
}

/** "literal" sentinel for the dropdown control (distinct from a literal that happens to be the empty string). */
const LITERAL_MODE = "__literal__" as const;
type Mode = typeof LITERAL_MODE | Placeholder;

interface ArgLeafPickerProps {
  /**
   * Current leaf value. When this is one of the 7 placeholder strings AND
   * `mode === "partial"`, the picker renders the placeholder dropdown
   * highlighted and hides the literal-value input.
   */
  value: unknown;
  onChange: (next: unknown) => void;
  /**
   * Effective `argumentMatching` mode for the parent matcher. Controls
   * which placeholder options are offered:
   *   - `partial` — literal + 7 placeholders
   *   - `exact`   — literal only (matcher uses deep equality; placeholders
   *                 would silently fail to type-check)
   *   - `ignore`  — args not compared; picker is disabled with a hint
   */
  argumentMatching?: "exact" | "partial" | "ignore";
  /**
   * Optional inferred JSON-schema type for this leaf (from the server
   * tool's inputSchema). Used to pre-select a sensible placeholder when
   * the user switches to a placeholder mode without choosing one yet.
   * Not validated against — purely a UX hint.
   */
  inferredType?: string;
  /**
   * Override for the literal-value placeholder text shown in the input.
   * Defaults to "Value".
   */
  inputPlaceholder?: string;
  /**
   * `value`-side className for layout (e.g. font-mono on the literal
   * input). Not applied to the placeholder dropdown.
   */
  className?: string;
  /** Read-only suppresses the dropdown's enabled state. */
  disabled?: boolean;
}

/**
 * Type-appropriate literal default for when the user toggles from
 * placeholder → literal and there's no remembered prior literal.
 */
function defaultLiteralFor(inferredType: string | undefined): unknown {
  switch (inferredType) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    case "array":
      return [];
    case "null":
      return null;
    default:
      return "";
  }
}

/**
 * Best-effort placeholder choice when the user switches a literal → a
 * generic placeholder mode and we haven't been told which one.
 */
function placeholderForInferredType(
  inferredType: string | undefined,
): Placeholder {
  switch (inferredType) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    case "null":
      return "null";
    default:
      return "any";
  }
}

/**
 * Stringify a literal JSON value for the inline input. Strings are
 * un-quoted; other JSON values are stringified so the user can edit
 * arrays/objects/null/numbers as text without breaking the round-trip.
 */
function literalToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Inverse of {@link literalToString}: try JSON-parse first (so the user
 * can type `42`, `true`, `null`, `[1,2]`, `{}`), fall back to the raw
 * string. Mirrors `ExpectedToolsEditor`'s historical coercion so the
 * picker is a drop-in replacement for its existing free-text input.
 */
function stringToLiteral(raw: string): unknown {
  if (raw === "") return "";
  // Match the pre-Phase-3 heuristics so existing cases round-trip
  // identically when the user is still typing literals.
  if (/^-?\d+\.?\d*$/.test(raw)) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      // Stay as string; the matcher will surface the type mismatch.
      return raw;
    }
  }
  return raw;
}

/**
 * Picker for a single args-blob leaf. Renders a mode dropdown on the
 * left and either a literal-value input or a placeholder label on the
 * right. Designed to drop in next to the existing free-text input in
 * {@link ExpectedToolsEditor} and to be reused in the predicate
 * authoring UI without coordinating extra state in the parent.
 */
export function ArgLeafPicker({
  value,
  onChange,
  argumentMatching,
  inferredType,
  inputPlaceholder,
  className,
  disabled,
}: ArgLeafPickerProps) {
  const inputId = useId();
  const isIgnore = argumentMatching === "ignore";
  const isExact = argumentMatching === "exact";
  // partial is the default if undefined — the matcher's own default.
  const allowPlaceholders = !isExact && !isIgnore;

  const valueIsPlaceholder = allowPlaceholders && isPlaceholder(value);
  const currentMode: Mode = valueIsPlaceholder
    ? (value as Placeholder)
    : LITERAL_MODE;

  const setMode = (nextMode: Mode) => {
    if (nextMode === LITERAL_MODE) {
      // Placeholder → literal: drop a type-appropriate default rather than
      // preserve the placeholder string. If the user wanted to write
      // `"string"` as a literal in exact mode, they can edit the field
      // after toggling.
      onChange(defaultLiteralFor(inferredType));
      return;
    }
    onChange(nextMode);
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 sm:flex-row sm:items-stretch",
        className,
      )}
    >
      <Select
        value={currentMode}
        onValueChange={(v) => setMode(v as Mode)}
        disabled={disabled || isIgnore}
      >
        <SelectTrigger
          className={cn(
            "h-9 w-full text-xs sm:w-32 shrink-0",
            valueIsPlaceholder &&
              "border-primary/40 bg-primary/5 text-primary",
          )}
          aria-label="Argument value mode"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LITERAL_MODE} className="text-xs">
            Literal
          </SelectItem>
          {allowPlaceholders ? (
            <>
              {PREDICATE_PLACEHOLDER_STRINGS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {/* "any value" / "any string" / … */}
                  <span className="italic text-muted-foreground">
                    {PLACEHOLDER_LABELS[p]}
                  </span>
                </SelectItem>
              ))}
            </>
          ) : null}
        </SelectContent>
      </Select>
      <div className="min-w-0 flex-1">
        {isIgnore ? (
          <div className="flex h-9 items-center rounded-md border border-dashed border-border/60 bg-muted/10 px-2 text-[11px] italic text-muted-foreground">
            Arguments not compared in ignore mode
          </div>
        ) : valueIsPlaceholder ? (
          <div className="flex h-9 items-center rounded-md border border-primary/30 bg-primary/5 px-2 text-xs italic text-primary">
            {PLACEHOLDER_LABELS[value as Placeholder]}
          </div>
        ) : (
          // Literal mode: a single-line input that mirrors the historical
          // coercion (parse numbers/booleans/null/JSON; fall back to
          // string). Booleans get a switch when inferredType says so —
          // small UX win, doesn't change the persisted shape.
          <LiteralValueEditor
            id={inputId}
            value={value}
            onChange={onChange}
            inferredType={inferredType}
            placeholder={inputPlaceholder ?? "Value"}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}

function LiteralValueEditor({
  id,
  value,
  onChange,
  inferredType,
  placeholder,
  disabled,
}: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  inferredType?: string;
  placeholder: string;
  disabled?: boolean;
}) {
  if (inferredType === "boolean") {
    const bool = value === true;
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-background px-2">
        <Switch
          id={id}
          checked={bool}
          onCheckedChange={(checked) => onChange(checked)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          {bool ? "true" : "false"}
        </span>
      </div>
    );
  }
  return (
    <Input
      id={id}
      value={literalToString(value)}
      onChange={(e) => onChange(stringToLiteral(e.target.value))}
      placeholder={placeholder}
      className="h-9 font-mono text-xs"
      disabled={disabled}
    />
  );
}

// Public re-exports for callers that want to render placeholder labels
// outside the picker itself (e.g. a read-only summary row).
export { PLACEHOLDER_LABELS, isPlaceholder, placeholderForInferredType };
