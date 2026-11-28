import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { PromptVariable } from "./variable-mapping-table";

// The same token grammar the backend's custom-judge parser uses, so every
// token it would reject on save is flagged here first.
const VARIABLE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Variable names a prompt uses, in order, without repeats. */
export function usedVariables(value: string): string[] {
  return [...new Set([...value.matchAll(VARIABLE)].map((m) => m[1]))];
}

/** A variable as it appears in the prompt. Unknown ones are flagged. */
function VariableChip({
  name,
  known,
}: {
  name: string;
  known: boolean;
}) {
  return (
    <span
      data-known={known}
      className={cn(
        "inline-flex rounded-sm px-1.5 py-0.5 font-mono text-[11px]",
        known
          ? "bg-muted text-foreground"
          : "bg-destructive/10 text-destructive",
      )}
    >
      {`{{${name}}}`}
    </span>
  );
}

/**
 * Typing {{ opens the list of variables the judge can read for an iteration.
 */
export function PromptEditor({
  value,
  onChange,
  variables,
  maxLength,
}: {
  value: string;
  onChange: (next: string) => void;
  variables: readonly PromptVariable[];
  maxLength: number;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [picking, setPicking] = useState(false);
  const [noRoom, setNoRoom] = useState<string | null>(null);
  // Where the {{ that opened the list ends, and where the caret goes once
  // the inserted token reaches the textarea.
  const trigger = useRef<number | null>(null);
  const caretAfterInsert = useRef<number | null>(null);
  useLayoutEffect(() => {
    const caret = caretAfterInsert.current;
    if (caret === null || !ref.current) return;
    caretAfterInsert.current = null;
    ref.current.setSelectionRange(caret, caret);
  }, [value]);
  const known = new Set(variables.map((v) => v.name));
  const used = usedVariables(value);
  const unknown = used.filter((name) => !known.has(name));

  const insert = (name: string) => {
    const caret =
      trigger.current ?? ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/\{\{$/, "");
    const token = `{{${name}}}`;
    const next = `${before}${token}${value.slice(caret)}`;
    setPicking(false);
    ref.current?.focus();
    // The picker bypasses maxLength, so check the limit here and leave the
    // prompt as it was when the token does not fit.
    if (next.length > maxLength) {
      setNoRoom(name);
      return;
    }
    setNoRoom(null);
    caretAfterInsert.current = before.length + token.length;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Judge prompt</Label>
      <Textarea
        ref={ref}
        id={id}
        rows={6}
        value={value}
        maxLength={maxLength}
        aria-invalid={unknown.length > 0}
        aria-describedby={`${id}-help`}
        className="min-h-28 field-sizing-fixed font-mono md:text-sm"
        onChange={(event) => {
          const next = event.target.value;
          const caret = event.target.selectionStart;
          onChange(next);
          setNoRoom(null);
          const opens = next.slice(0, caret).endsWith("{{");
          trigger.current = opens ? caret : null;
          setPicking(opens);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPicking(false);
        }}
      />
      {picking ? (
        <ul
          role="listbox"
          aria-label="Variables"
          className="rounded-md border border-border bg-popover p-1 shadow-sm"
        >
          {variables.map((variable) => (
            <li
              key={variable.name}
              role="option"
              aria-selected={false}
              tabIndex={0}
              onClick={() => insert(variable.name)}
              onKeyDown={(event) => {
                if (event.key === "Enter") insert(variable.name);
              }}
              className="flex cursor-pointer justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-muted"
            >
              <span className="font-mono">{variable.name}</span>
              <span className="text-muted-foreground">{variable.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        id={`${id}-help`}
        className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      >
        <span>Reads one iteration.</span>
        {used.map((name) => (
          <VariableChip key={name} name={name} known={known.has(name)} />
        ))}
        {unknown.length ? (
          <span className="text-destructive">
            Unknown variable: {unknown.join(", ")}. Type {"{{"} to pick one from
            the list.
          </span>
        ) : null}
        {noRoom ? (
          <span className="text-destructive">
            No room for {`{{${noRoom}}}`}. Shorten the prompt to add it.
          </span>
        ) : null}
        <span className="ml-auto">
          {value.length}/{maxLength}
        </span>
      </div>
    </div>
  );
}
