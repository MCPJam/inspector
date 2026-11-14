/**
 * The test plan's tools, in the order their cases run: what each tool's
 * calls may do and change, whether it runs, and its cases with their
 * arguments and expected result. Each issue sits on the tool or case it
 * names. Text edits are kept when the field is left, so a half-typed value
 * never reaches the plan.
 */
import { useState } from "react";
import type {
  DirectoryTestCase,
  DirectoryTestExclusionReason,
  DirectoryTestPlan,
  DirectoryTestPlanIssue,
  DirectoryToolPlan,
} from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Textarea } from "@mcpjam/design-system/textarea";
import { editCase, editExclusion, setToolAction } from "./test-plan-edits";

type Edit = (change: (plan: DirectoryTestPlan) => DirectoryTestPlan) => void;

const EFFECT = {
  read: "Reads",
  write: "Writes",
  destructive: "Can destroy data",
} as const;
const ACTION = {
  run: "Runs",
  "negative-only": "Negative cases only",
  excluded: "Excluded",
} as const;
const REASON: Record<DirectoryTestExclusionReason, string> = {
  destructive: "Destructive",
  costly: "Costly",
  "external-effects": "Reaches outside the server",
  "needs-a-person": "Needs a person",
  other: "Another reason",
};
const EXPECTED = {
  any: "Any refusal",
  "invalid-arguments": "Invalid arguments",
  "tool-error": "An error from the tool",
} as const;
const HINT = "text-xs text-muted-foreground";

export function IssueList({
  issues,
}: {
  issues: readonly DirectoryTestPlanIssue[];
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm text-destructive">
      {issues.map((issue, index) => (
        <li key={index}>{issue.message}</li>
      ))}
    </ul>
  );
}

function Choice<T extends string>(props: {
  id: string;
  label: string;
  value: T | undefined;
  options: Record<T, string>;
  onChange: (value: T) => void;
}) {
  const { id, label, value, options, onChange } = props;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className={HINT}>
        {label}
      </Label>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} size="sm" className="w-52">
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(options) as T[]).map((key) => (
            <SelectItem key={key} value={key}>
              {options[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Arguments as JSON. Emptied, the case has none, and a run can draft them. */
function ArgumentsField(props: {
  id: string;
  value: DirectoryTestCase["arguments"];
  onChange: (value: DirectoryTestCase["arguments"]) => void;
}) {
  const shown =
    props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
  const [invalid, setInvalid] = useState(false);
  const commit = (text: string) => {
    if (text === shown) return;
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: the text stays in the box, with the error line.
      parsed = null;
    }
    const object =
      parsed === undefined ||
      (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
    setInvalid(!object);
    if (object) props.onChange(parsed as DirectoryTestCase["arguments"]);
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={props.id} className={HINT}>
        Arguments, as JSON
      </Label>
      <Textarea
        id={props.id}
        defaultValue={shown}
        rows={Math.min(8, shown.split("\n").length + 1)}
        aria-invalid={invalid}
        onBlur={(event) => commit(event.target.value)}
        className="font-mono text-xs"
      />
      {invalid ? (
        <p className="text-xs text-destructive">
          Arguments must be a JSON object. Correct them to keep this change.
        </p>
      ) : null}
    </div>
  );
}

function CaseRow(props: {
  testCase: DirectoryTestCase;
  order: number;
  total: number;
  issues: readonly DirectoryTestPlanIssue[];
  edit: Edit;
}) {
  const { testCase, order, total, edit } = props;
  const id = `test-plan-case-${testCase.id}`;
  const kind = testCase.kind === "valid" ? "valid input" : "negative case";
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <p className="text-sm">{`${testCase.id}, ${kind}, runs ${order} of ${total}`}</p>
      <ArgumentsField
        key={JSON.stringify(testCase.arguments) ?? ""}
        id={`${id}-arguments`}
        value={testCase.arguments}
        onChange={(value) =>
          edit((plan) => editCase(plan, testCase.id, { arguments: value }))
        }
      />
      {testCase.kind === "negative" ? (
        <Choice
          id={`${id}-expected`}
          label="Expected refusal"
          value={testCase.expectedError ?? "any"}
          options={EXPECTED}
          onChange={(expectedError) =>
            edit((plan) => editCase(plan, testCase.id, { expectedError }))
          }
        />
      ) : (
        <p className={HINT}>Expects a result.</p>
      )}
      {testCase.expectation ? (
        <p className={HINT}>{testCase.expectation}</p>
      ) : null}
      <IssueList
        issues={props.issues.filter((issue) => issue.caseId === testCase.id)}
      />
    </div>
  );
}

function ToolRow(props: {
  entry: DirectoryToolPlan;
  plan: DirectoryTestPlan;
  saved?: DirectoryTestPlan;
  issues: readonly DirectoryTestPlanIssue[];
  edit: Edit;
}) {
  const { entry, plan, saved, edit } = props;
  const { tool, exclusion } = entry;
  const id = `test-plan-tool-${tool}`;
  const writes = entry.writes.length > 0 ? entry.writes.join(", ") : "none";
  const own = props.issues.filter(
    (issue) => issue.tool === tool && !issue.caseId,
  );
  return (
    <li className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-mono text-sm">{tool}</p>
          <p className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{EFFECT[entry.effect]}</Badge>
            {entry.openWorld ? (
              <Badge variant="outline">Reaches outside the server</Badge>
            ) : null}
          </p>
          <p className={HINT}>{`Permitted writes: ${writes}`}</p>
        </div>
        <Choice
          id={`${id}-action`}
          label="In the plan"
          value={entry.action}
          options={ACTION}
          onChange={(action) =>
            edit((current) => setToolAction(current, tool, action, saved))
          }
        />
        {entry.action === "excluded" ? (
          <Choice
            id={`${id}-reason`}
            label="Excluded because"
            value={exclusion?.reason}
            options={REASON}
            onChange={(reason) =>
              edit((current) =>
                editExclusion(current, tool, { ...exclusion, reason }),
              )
            }
          />
        ) : null}
      </div>
      {exclusion?.reason === "other" ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-note`} className={HINT}>
            Why it is excluded
          </Label>
          <Input
            key={exclusion.note ?? ""}
            id={`${id}-note`}
            defaultValue={exclusion.note ?? ""}
            onBlur={(event) => {
              const note = event.target.value.trim();
              if (note === (exclusion.note ?? "")) return;
              const next = {
                reason: exclusion.reason,
                ...(note ? { note } : {}),
              };
              edit((current) => editExclusion(current, tool, next));
            }}
          />
        </div>
      ) : null}
      <IssueList issues={own} />
      {plan.cases.map((testCase, index) =>
        testCase.tool === tool ? (
          <CaseRow
            key={testCase.id}
            testCase={testCase}
            order={index + 1}
            total={plan.cases.length}
            issues={props.issues}
            edit={edit}
          />
        ) : null,
      )}
    </li>
  );
}

/** The plan's tools, the first to run first; a tool with no case to run last. */
export function TestPlanTools(props: {
  plan: DirectoryTestPlan;
  saved?: DirectoryTestPlan;
  issues: readonly DirectoryTestPlanIssue[];
  edit: Edit;
}) {
  const { plan } = props;
  const first = (tool: string) => {
    const index = plan.cases.findIndex((entry) => entry.tool === tool);
    return index === -1 ? plan.cases.length : index;
  };
  const tools = [...plan.tools].sort((a, b) => first(a.tool) - first(b.tool));
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Tools, in the order their cases run
      </h3>
      <ul className="space-y-3">
        {tools.map((entry) => (
          <ToolRow key={entry.tool} entry={entry} {...props} />
        ))}
      </ul>
    </div>
  );
}
