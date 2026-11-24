import { useId, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { ToggleGroup, ToggleGroupItem } from "@mcpjam/design-system/toggle-group";
import {
  MAX_SAVED_CASES,
  addCase,
  describeCase,
  removeCase,
  type Answering,
  type CaseRow,
  type RealTool,
  type ToolDraft,
} from "./mock-sheet-model";

const ANSWERING: Array<{ value: Answering; label: string }> = [
  { value: "server", label: "Your server" },
  { value: "saved", label: "Saved answers" },
  { value: "model", label: "A model" },
];

function CaseEditor({
  row,
  number,
  onChange,
  onRemove,
}: {
  row: CaseRow;
  number: number;
  onChange: (row: CaseRow) => void;
  onRemove: () => void;
}) {
  const remove = (
    <Button size="sm" variant="ghost" className="text-muted-foreground" aria-label={`Remove case ${number}`} onClick={onRemove}>
      Remove
    </Button>
  );
  if (row.kind === "stored") {
    const { when, answer } = describeCase(row.saved);
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span>
            When <span className="font-mono text-xs">{when}</span>, answer with
          </span>
          {remove}
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-code-bg p-3 text-xs">{answer}</pre>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>When</span>
        <Input
          aria-label={`Case ${number} input name`}
          placeholder="runId"
          className="w-28 font-mono text-xs"
          value={row.whenKey}
          onChange={(event) => onChange({ ...row, whenKey: event.target.value })}
        />
        <span>is</span>
        <Input
          aria-label={`Case ${number} input value`}
          placeholder="run_41"
          className="w-28 font-mono text-xs"
          value={row.whenValue}
          onChange={(event) => onChange({ ...row, whenValue: event.target.value })}
        />
        <span className="ml-auto">{remove}</span>
      </div>
      <Textarea
        aria-label={`Case ${number} saved result`}
        rows={4}
        className="font-mono text-xs"
        placeholder={'{"content": [{"type": "text", "text": "..."}]}'}
        value={row.resultText}
        onChange={(event) => onChange({ ...row, resultText: event.target.value })}
      />
    </div>
  );
}

/** One tool of the mock: its description, its schema, and how it answers. */
export function MockToolEditor({
  name,
  draft,
  real,
  schema,
  canAnswerFromServer,
  onChange,
}: {
  name: string;
  draft: ToolDraft;
  real: RealTool | undefined;
  schema: { schema: unknown; edited: boolean };
  /** False for a tool only the mock lists: it has no real tool to call. */
  canAnswerFromServer: boolean;
  onChange: (draft: ToolDraft) => void;
}) {
  const id = useId();
  const [showReal, setShowReal] = useState(false);
  const setRow = (next: CaseRow) =>
    onChange({ ...draft, rows: draft.rows.map((row) => (row.id === next.id ? next : row)) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-description`}>Description</Label>
          {real?.description !== undefined ? (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setShowReal(!showReal)}>
              {showReal ? "Hide what your server says" : "See what your server says"}
            </Button>
          ) : null}
        </div>
        <Textarea
          id={`${id}-description`}
          rows={3}
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
        {showReal && real?.description !== undefined ? (
          <p className="rounded-md border border-border bg-code-bg p-3 text-xs" aria-label={`What your server says about ${name}`}>
            {real.description}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>Input schema</span>
          <span className="text-muted-foreground">{schema.edited ? "As edited" : "As your server lists it"}</span>
        </div>
        {schema.schema === undefined ? null : (
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-code-bg p-3 text-xs">
            {JSON.stringify(schema.schema, null, 2)}
          </pre>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label>How it answers</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={draft.answering}
          onValueChange={(value) => value && onChange({ ...draft, answering: value as Answering })}
          className="w-fit"
          aria-label="How it answers"
        >
          {ANSWERING.filter((option) => option.value !== "server" || canAnswerFromServer).map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className="px-3">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {draft.answering === "saved" ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">The first case that matches the call answers it.</p>
            {draft.rows.map((row, index) => (
              <CaseEditor
                key={row.id}
                row={row}
                number={index + 1}
                onChange={setRow}
                onRemove={() => onChange(removeCase(draft, row.id))}
              />
            ))}
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              disabled={draft.rows.length >= MAX_SAVED_CASES}
              onClick={() => onChange(addCase(draft))}
            >
              Add a case
            </Button>
            {draft.rows.length >= MAX_SAVED_CASES ? (
              <p className="text-xs text-muted-foreground">A tool holds {MAX_SAVED_CASES} cases at most.</p>
            ) : null}
          </div>
        ) : null}
        {draft.answering === "model" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-instructions`}>Instructions</Label>
            <Textarea
              id={`${id}-instructions`}
              rows={4}
              placeholder="What the data looks like, and what this tool refuses."
              value={draft.instructions}
              onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              A model answers from the description and these instructions. The first answer to a call is kept and reused.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
