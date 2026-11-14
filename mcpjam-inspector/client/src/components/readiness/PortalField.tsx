/**
 * One portal field, drawn by its `control` from the flow definition: the
 * portal's label, placeholder, counter, helper and error line, then MCPJam's
 * results for the checks that read it.
 */
import { useState } from "react";
import { X } from "lucide-react";
import type {
  DirectoryAnswerValue,
  DirectoryFieldIssue,
  DirectoryFlowField,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { cn } from "@mcpjam/design-system/cn";
import { Input } from "@mcpjam/design-system/input";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Textarea } from "@mcpjam/design-system/textarea";
import { McpjamChecks } from "./McpjamChecks";

const INPUT =
  "rounded-lg border-transparent bg-muted text-sm placeholder:text-muted-foreground/70";
/** Controls a `<label for>` can name; the rest are groups it labels by id. */
const LABELLED = ["text", "textarea", "select", "secret"];

export interface PortalFieldProps {
  field: DirectoryFlowField;
  value: DirectoryAnswerValue | undefined;
  /** The portal's error line, shown once its step is marked. */
  issue?: DirectoryFieldIssue;
  findings?: readonly PlacedFinding[];
  /** The submission's server, which a `server` field selects. */
  serverUrl?: string;
  onChange: (value: DirectoryAnswerValue) => void;
}

type ControlProps = PortalFieldProps & {
  id: string;
  invalid: boolean;
  /** The error line's id, while there is one. */
  describedBy?: string;
};

const listOf = (value: DirectoryAnswerValue | undefined): readonly unknown[] =>
  Array.isArray(value) ? value : [];
const stringsOf = (value: DirectoryAnswerValue | undefined) =>
  listOf(value).filter((entry): entry is string => typeof entry === "string");
const rowsOf = (value: DirectoryAnswerValue | undefined) =>
  listOf(value).filter(
    (row): row is Record<string, string> =>
      typeof row === "object" && row !== null,
  );

/** The portal's red asterisk; assistive tech hears the word. */
const REQUIRED = (
  <>
    <span aria-hidden="true" className="text-destructive">
      {" *"}
    </span>
    <span className="sr-only"> (required)</span>
  </>
);

/** Several of a field's options, ticked: acknowledgments, or a multi-select. */
function OptionList(props: ControlProps) {
  const { field, id, value, describedBy, onChange } = props;
  const chosen = stringsOf(value);
  // At the limit, only a ticked option can change: unticking it.
  const full = chosen.length >= (field.maxItems ?? Infinity);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
      className="rounded-xl bg-card px-4"
    >
      {field.options?.map((option) => (
        <label
          key={option.value}
          className="flex items-start gap-3 border-b border-border py-3 text-sm last:border-b-0"
        >
          <Checkbox
            checked={chosen.includes(option.value)}
            disabled={full && !chosen.includes(option.value)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...chosen, option.value]
                  : chosen.filter((entry) => entry !== option.value),
              )
            }
            className="mt-0.5"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** A multi-select with no options takes what the person types: the portal's list was never captured. */
function FreeEntry(props: ControlProps) {
  const { field, id, value, invalid, describedBy, onChange } = props;
  const [entry, setEntry] = useState("");
  const chosen = stringsOf(value);
  const full = chosen.length >= (field.maxItems ?? Infinity);
  const add = () => {
    const item = entry.trim();
    if (item && !full && !chosen.includes(item)) onChange([...chosen, item]);
    setEntry("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {chosen.map((item) => (
          <button
            key={item}
            type="button"
            aria-label={`Remove ${item}`}
            onClick={() => onChange(chosen.filter((other) => other !== item))}
            className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {item}
            <X aria-hidden="true" className="size-3" />
          </button>
        ))}
      </div>
      <Input
        id={id}
        aria-labelledby={`${id}-label`}
        value={entry}
        disabled={full}
        placeholder={field.placeholder}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => setEntry(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add();
        }}
        onBlur={add}
        className={INPUT}
      />
    </div>
  );
}

function Pairs({ field, id, value, describedBy, onChange }: ControlProps) {
  const spec = field.pairs;
  if (!spec) return null;
  const rows = rowsOf(value);
  const [left, right] = spec.keys;
  const set = (index: number, column: string, cell: string) => {
    const next = Array.from(
      { length: Math.max(rows.length, index + 1) },
      (_, at) => ({ [left]: "", [right]: "", ...rows[at] }),
    );
    next[index] = { ...next[index], [column]: cell };
    // Empty trailing rows are inputs nobody used, not answers.
    const blank = (row: Record<string, string>) =>
      !`${row[left]}${row[right]}`.trim();
    while (next.length > 0 && blank(next[next.length - 1])) next.pop();
    onChange(next);
  };
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
      className="grid grid-cols-[2fr_3fr] gap-x-3 gap-y-2"
    >
      {spec.columns.map((column) => (
        <span key={column} className="text-sm text-muted-foreground">
          {column}
        </span>
      ))}
      {Array.from({ length: spec.maxRows }, (_, index) =>
        spec.keys.map((column, side) => (
          <Input
            key={`${index}-${column}`}
            aria-label={`${spec.columns[side]} ${index + 1}`}
            value={rows[index]?.[column] ?? ""}
            placeholder={spec.placeholders?.[index]?.[side]}
            onChange={(event) => set(index, column, event.target.value)}
            className={INPUT}
          />
        )),
      )}
    </div>
  );
}

function Control(props: ControlProps) {
  const { field, id, value, invalid, describedBy, serverUrl, onChange } = props;
  const text = typeof value === "string" ? value : "";
  const options = field.options ?? [];
  switch (field.control) {
    case "textarea":
      return (
        <Textarea
          id={id}
          rows={4}
          value={text}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT}
        />
      );
    case "select":
      return (
        <Select value={text} onValueChange={onChange}>
          <SelectTrigger
            id={id}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            className={cn("w-full", INPUT)}
          >
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "multi-select":
      return field.options ? (
        <OptionList {...props} />
      ) : (
        <FreeEntry {...props} />
      );
    case "checkbox-group":
      return <OptionList {...props} />;
    case "pairs":
      return <Pairs {...props} />;
    case "radio":
    case "radio-cards": {
      const cards = field.control === "radio-cards";
      return (
        <RadioGroup
          value={text}
          onValueChange={onChange}
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          className="gap-2.5"
        >
          {options.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex items-start gap-3 text-sm",
                cards && "rounded-xl border px-4 py-3",
                cards &&
                  (text === option.value
                    ? "border-ring/60 bg-ring/10"
                    : "border-border"),
              )}
            >
              <RadioGroupItem value={option.value} className="mt-0.5" />
              <span>
                {option.label}
                {option.help ? (
                  <span className="block text-muted-foreground">
                    {option.help}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </RadioGroup>
      );
    }
    case "checkbox":
      return (
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            id={id}
            checked={value === true}
            aria-describedby={describedBy}
            onCheckedChange={(checked) => onChange(checked === true)}
            className="mt-0.5"
          />
          {field.label}
        </label>
      );
    case "server":
      return (
        <div className="flex items-center gap-4 rounded-xl bg-card px-4 py-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {serverUrl ??
              "This server has no URL. Claude lists remote servers only."}
          </span>
          {!serverUrl ? null : value === serverUrl ? (
            <span className="rounded-full bg-success/15 px-2.5 py-0.5 text-xs">
              Selected
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onChange(serverUrl)}
            >
              Select
            </Button>
          )}
        </div>
      );
    default:
      return (
        <Input
          id={id}
          value={text}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT}
        />
      );
  }
}

export function PortalField(props: PortalFieldProps) {
  const { field, value, issue, findings = [] } = props;
  const id = `portal-${field.key}`;
  const errorId = `${id}-error`;
  const length = typeof value === "string" ? value.length : 0;
  const over = field.maxLength !== undefined && length > field.maxLength;
  // The review page alone asks for these, so the form shows no mark.
  const required = field.required && field.requiredOn !== "review";
  return (
    <div className="space-y-2">
      {field.control === "checkbox" ? null : (
        <label
          id={`${id}-label`}
          htmlFor={LABELLED.includes(field.control) ? id : undefined}
          className="block text-sm font-medium"
        >
          {field.label}
          {required ? REQUIRED : null}
        </label>
      )}
      <Control
        {...props}
        id={id}
        invalid={Boolean(issue) || over}
        describedBy={issue ? errorId : undefined}
      />
      {issue ? (
        <p id={errorId} className="text-sm text-destructive">
          Error: {issue.message}
        </p>
      ) : null}
      {field.maxLength !== undefined ? (
        <p
          className={cn(
            "text-sm tabular-nums",
            over ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {length} / {field.maxLength} characters
        </p>
      ) : null}
      {field.helper ? (
        <p className="text-sm text-muted-foreground">{field.helper}</p>
      ) : null}
      <McpjamChecks findings={findings} />
    </div>
  );
}
