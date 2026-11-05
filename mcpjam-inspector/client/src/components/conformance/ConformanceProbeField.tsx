/**
 * The tool a check that must call one may use, set right under that check in
 * the check list: tool inputs live with the checks they serve, not in a
 * separate dialog.
 *
 * It SUGGESTS (read-only tools first, a warning on tools that say they may
 * modify data) and never picks for the operator, for the same reason the SDK
 * does not: nothing a server advertises says a tool is safe to call.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { MCP_LOG_LEVELS, type MCPLogLevel } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  useServerToolsData,
  type ToolsDataStatus,
} from "@/lib/host-compat/use-host-compat";
import { ToolCallArgsEditor } from "@/components/evals/checks-section";
import { acceptsEmptyToolArguments } from "./conformance-tool-input";
import {
  LOG_LEVEL_ADVICE,
  PROBE_CHECKS,
  probeKeyFor,
  type ConformanceProbe,
  type ConformanceProbeKey,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";

const NONE = "__none__";
/** What the SDK asks for when the operator picks no level. */
const DEFAULT_LOG_LEVEL: MCPLogLevel = "warning";

const PROBE_COPY: Record<
  ConformanceProbeKey,
  { label: string; hint: string; unsetHint?: string }
> = {
  logProbe: {
    label: "Tool that emits logs",
    hint: "Pick a tool that writes logs and is safe to call repeatedly. It is called up to 3 times.",
  },
  inputRequiredProbe: {
    label: "Tool that asks for input",
    hint: "Called once. Pick one that asks the user for input before it finishes.",
  },
  toolCallProbe: {
    label: "Tool to check output",
    hint: "Called once. Its result is checked against the output schema it declares.",
  },
  tasksProbe: {
    label: "Tool that creates a task",
    hint: "Creates tasks for the selected checks. Checks that change a task use separate tasks.",
    unsetHint:
      "Without a tool, these checks could not run on a server that uses the Tasks extension.",
  },
};

interface ToolOption {
  name: string;
  readOnly: boolean;
  destructive: boolean;
  /** The tool's input schema properties: the argument names to offer. */
  argProperties?: Record<string, unknown>;
  /** Declares an output schema: the only tools the output check can grade. */
  hasOutputSchema: boolean;
  /** Legacy task tools the runner can pick without a manual selection. */
  taskSupport?: "required" | "optional";
  inputSchema?: Record<string, unknown>;
}

/** Read-only tools first: they are the likeliest safe choice. */
function sortForSafety(tools: ToolOption[]): ToolOption[] {
  return [...tools].sort(
    (a, b) =>
      Number(b.readOnly) - Number(a.readOnly) ||
      Number(a.destructive) - Number(b.destructive) ||
      a.name.localeCompare(b.name),
  );
}

/** The server's tools for every probe field, listed once. */
export interface ProbeTools {
  tools: ToolOption[];
  /** The runner's first advertised task tool accepts its default {} arguments. */
  canAutoPickTaskTool?: boolean;
  status: ToolsDataStatus;
  /** The server kept paging past the cap: `tools` is not the whole list. */
  truncated?: boolean;
}

/**
 * One list for all the fields: every page, and only once the server is
 * connected, retried like the other surfaces that list a server's tools.
 */
export function useProbeTools(server: ServerWithName | null): ProbeTools {
  const { data, status } = useServerToolsData(server, { allPages: true });
  const taskTools = useMemo(() => {
    const listed = (data?.tools ?? []).map<ToolOption>((tool) => {
      const execution = "execution" in tool ? tool.execution : undefined;
      const taskSupport =
        execution && typeof execution === "object" && "taskSupport" in execution
          ? execution.taskSupport
          : undefined;
      return {
        name: tool.name,
        readOnly: tool.annotations?.readOnlyHint === true,
        destructive:
          tool.annotations?.readOnlyHint !== true &&
          tool.annotations?.destructiveHint !== false,
        argProperties: tool.inputSchema?.properties,
        inputSchema: tool.inputSchema,
        hasOutputSchema: tool.outputSchema !== undefined,
        taskSupport:
          taskSupport === "required" || taskSupport === "optional"
            ? taskSupport
            : undefined,
      };
    });
    // Match the runner's required-first choice in server listing order,
    // before sorting the dropdown for safety.
    const automatic =
      listed.find((tool) => tool.taskSupport === "required") ??
      listed.find((tool) => tool.taskSupport === "optional");
    return {
      tools: sortForSafety(listed),
      canAutoPickTaskTool:
        automatic !== undefined &&
        acceptsEmptyToolArguments(automatic.inputSchema),
    };
  }, [data]);
  return { ...taskTools, status, truncated: Boolean(data?.nextCursor) };
}

const FIELD_BOX =
  "space-y-2 rounded-md border border-border/60 bg-muted/20 p-3";

/**
 * The level the log level filtering advice asks the log tool for. Kept on the
 * log probe, so it needs a tool first.
 */
function LogLevelField({
  probe,
  onChange,
}: {
  probe: ConformanceProbe;
  onChange: (probe: ConformanceProbe) => void;
}) {
  const id = useId();
  return (
    <>
      <Label htmlFor={id} className="text-xs">
        Log level to request
      </Label>
      <Select
        value={probe.level ?? DEFAULT_LOG_LEVEL}
        onValueChange={(next) =>
          onChange({ ...probe, level: next as MCPLogLevel })
        }
      >
        <SelectTrigger id={id} className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MCP_LOG_LEVELS.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Calls the tool once at this level. You get a tip if it sends lower-level
        logs or none.
      </p>
    </>
  );
}

/**
 * The answers `tasks/update` sends when the task asks for input, as raw JSON:
 * what a task asks is server-defined, so there is no form to build. Empty
 * means none, and then the update acknowledgement check is not applicable.
 * Kept on the Tasks probe, so it needs a tool first.
 */
/** The Tasks routes refuse answers that serialize past this (a 400). */
const MAX_ANSWERS_CHARS = 10_000;

export function TaskAnswersField({
  probe,
  onChange,
  onInvalidChange,
}: {
  probe: ConformanceProbe;
  onChange: (probe: ConformanceProbe) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const [text, setText] = useState(() =>
    probe.inputResponses ? JSON.stringify(probe.inputResponses, null, 2) : "",
  );
  const [error, setError] = useState<string | null>(null);
  // Gone (its tool cleared or changed) means nothing left to fix.
  const onInvalidChangeRef = useRef(onInvalidChange);
  useEffect(() => {
    onInvalidChangeRef.current = onInvalidChange;
  });
  useEffect(() => () => onInvalidChangeRef.current(false), []);

  const withAnswers = (inputResponses?: Record<string, unknown>) => {
    const next = { ...probe };
    if (inputResponses) next.inputResponses = inputResponses;
    else delete next.inputResponses;
    return next;
  };

  const change = (next: string) => {
    setText(next);
    if (next.trim() === "") {
      setError(null);
      onInvalidChange(false);
      onChange(withAnswers());
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Enter a JSON object, keyed by the task's input request keys.");
      onInvalidChange(true);
      return;
    }
    if (JSON.stringify(parsed).length > MAX_ANSWERS_CHARS) {
      setError("Keep the answers under 10,000 characters.");
      onInvalidChange(true);
      return;
    }
    setError(null);
    onInvalidChange(false);
    onChange(withAnswers(parsed as Record<string, unknown>));
  };

  return (
    <>
      <Label htmlFor={id} className="text-xs">
        Answers to the task's questions (optional)
      </Label>
      <Textarea
        id={id}
        value={text}
        onChange={(event) => change(event.target.value)}
        placeholder={
          '{ "confirm": { "action": "accept", "content": { "ok": true } } }'
        }
        className="min-h-20 font-mono text-xs"
        aria-invalid={error !== null}
        aria-describedby={messageId}
      />
      {error ? (
        <p id={messageId} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p id={messageId} className="text-xs text-muted-foreground">
          Sent when the task asks for input. Without answers, this check does
          not apply.
        </p>
      )}
    </>
  );
}

/** A tool's name, with what its annotations say about safety as a badge. */
function ToolOptionLabel({
  tool,
}: {
  tool: { name: string; readOnly: boolean; destructive: boolean };
}) {
  const safety = tool.readOnly
    ? "read-only"
    : tool.destructive
      ? "may modify data"
      : undefined;
  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="truncate">{tool.name}</span>
      {safety ? (
        <Badge
          variant="outline"
          className="rounded-full px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
        >
          {/* Read aloud as "echo · read-only", not "echoread-only". */}
          <span className="sr-only">·</span>
          {safety}
        </Badge>
      ) : null}
    </span>
  );
}

export function ConformanceProbeField({
  probeKey,
  tools: { tools: allTools, status, truncated },
  probe,
  onChange,
  onValidChange,
  showLevel = false,
  forCheck,
}: {
  probeKey: ConformanceProbeKey;
  tools: ProbeTools;
  probe: ConformanceProbe | undefined;
  onChange: (probe: ConformanceProbe | undefined) => void;
  /** False while the Raw JSON box holds text that does not parse. */
  onValidChange?: (valid: boolean) => void;
  /** Also ask for the log level, under the log level filtering advice. */
  showLevel?: boolean;
  /** The check this field belongs to, so each row's dropdown has its own name. */
  forCheck?: string;
}) {
  const id = useId();
  // A tool with no output schema gives the output check nothing to grade.
  const options =
    probeKey === "toolCallProbe"
      ? allTools.filter((tool) => tool.hasOutputSchema)
      : allTools;
  // With no output schema declared at all, the editor shades the output check
  // and shows no field, so this field never has to say it does not apply.
  const unsetHint =
    PROBE_COPY[probeKey].unsetHint ??
    "Without a tool, this check reports that it could not run.";
  // The editor reports validity from an effect keyed on this callback, so it
  // must keep one identity while the parent re-renders.
  const onValidChangeRef = useRef(onValidChange);
  useEffect(() => {
    onValidChangeRef.current = onValidChange;
  });
  const reportInvalid = useCallback(
    (invalid: boolean) => onValidChangeRef.current?.(!invalid),
    [],
  );
  useEffect(() => () => onValidChangeRef.current?.(true), []);
  const toolName = probe?.toolName || NONE;
  // A saved tool the server no longer lists stays selectable, so opening the
  // list never silently drops a choice.
  const listed = options.some((tool) => tool.name === toolName);
  // Look in every tool, not just the offered ones: a saved tool that lost its
  // output schema is still called, so it keeps its warning and arguments.
  const selected = allTools.find((tool) => tool.name === toolName);
  const copy = PROBE_COPY[probeKey];

  const level = probe?.level ? { level: probe.level } : {};
  const answers = probe?.inputResponses
    ? { inputResponses: probe.inputResponses }
    : {};

  // Another tool takes other arguments, and asks other questions, so a new
  // pick starts with neither. The log level is not about the tool, so it
  // stays.
  const changeTool = (next: string) =>
    onChange(next === NONE ? undefined : { toolName: next, ...level });

  const changeArguments = (args: Record<string, unknown>) =>
    onChange({
      toolName,
      ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
      ...level,
      ...answers,
    });

  return (
    <div className={FIELD_BOX}>
      <Label htmlFor={id} className="text-xs">
        {copy.label}
      </Label>
      {/* Above the dropdown: what to pick is read before picking. */}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {copy.hint}
      </p>
      <Select
        value={toolName}
        onValueChange={changeTool}
        disabled={status === "loading" || status === "idle"}
      >
        {/* The value and item text stretch so a tool's badge sits at the right. */}
        <SelectTrigger
          id={id}
          className="h-8 w-full text-xs *:data-[slot=select-value]:flex-1"
          aria-label={forCheck ? `${copy.label} for ${forCheck}` : undefined}
          aria-describedby={`${id}-hint`}
        >
          <SelectValue
            placeholder={status === "loading" ? "Loading tools..." : "Not set"}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not set</SelectItem>
          {!listed && toolName !== NONE ? (
            <SelectItem value={toolName} className="*:[span]:last:flex-1">
              {selected ? (
                <ToolOptionLabel tool={selected} />
              ) : (
                `${toolName} (not listed by the server)`
              )}
            </SelectItem>
          ) : null}
          {options.map((tool) => (
            <SelectItem
              key={tool.name}
              value={tool.name}
              className="*:[span]:last:flex-1"
            >
              <ToolOptionLabel tool={tool} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {toolName === NONE ? (
        <p className="text-xs text-muted-foreground">{unsetHint}</p>
      ) : // The SDK still calls it, but with no schema there is nothing to
      // grade, so the check reports that it could not run.
      probeKey === "toolCallProbe" && selected && !selected.hasOutputSchema ? (
        <p className="text-xs text-muted-foreground">
          This tool no longer declares an output schema. It is still called,
          but its result cannot be checked. Pick another tool or clear it.
        </p>
      ) : null}
      {status === "failed" ? (
        <p className="text-xs text-destructive">
          Couldn't list this server's tools. Check its connection, then open
          this step again.
        </p>
      ) : truncated ? (
        <p className="text-xs text-muted-foreground">
          This server lists more tools than can be shown here. Only the first{" "}
          {options.length} are offered.
        </p>
      ) : status === "idle" ? (
        <p className="text-xs text-muted-foreground">
          Connect this server to list its tools.
        </p>
      ) : null}
      {toolName !== NONE ? (
        // Keyed by tool: the Raw JSON switch starts over for each one.
        <ToolCallArgsEditor
          key={toolName}
          value={probe?.arguments ?? {}}
          onChange={changeArguments}
          argProperties={selected?.argProperties}
          onInvalidChange={reportInvalid}
        />
      ) : null}
      {showLevel && probe ? (
        <LogLevelField probe={probe} onChange={onChange} />
      ) : null}
    </div>
  );
}

function sameArguments(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * A check's own tool, under its row. The dropdown always shows, filled with
 * the tool the check inherits until the operator picks another. A change to
 * the tool or its arguments becomes this check's own choice and clears the
 * box; ticking the box drops that choice. A change that keeps the inherited
 * tool and arguments (the log level) still edits the inherited probe.
 */
export function CheckToolField({
  probeKey,
  tools,
  inherited,
  override,
  inheritLabel,
  checkTitle,
  hint,
  showLevel = false,
  keepAnswers = false,
  onOverrideChange,
  onInheritedChange,
  onValidChange,
}: {
  probeKey: ConformanceProbeKey;
  tools: ProbeTools;
  inherited: ConformanceProbe | undefined;
  override: ConformanceProbe | undefined;
  inheritLabel: string;
  /** The row's title, so its dropdown has its own accessible name. */
  checkTitle?: string;
  hint?: string;
  /** Also ask for the log level, under the log level filtering advice. */
  showLevel?: boolean;
  /** Keep the task's input answers on this check's own choice. */
  keepAnswers?: boolean;
  onOverrideChange: (probe: ConformanceProbe | undefined) => void;
  onInheritedChange?: (probe: ConformanceProbe) => void;
  /** False while this check's own choice has no tool or a draft that does not parse. */
  onValidChange: (valid: boolean) => void;
}) {
  const effective = override ?? inherited;
  // Only the extras this check sends: a level for the log advice, answers for
  // the update check.
  const own = (probe: ConformanceProbe): ConformanceProbe => {
    const { level, inputResponses, ...rest } = probe;
    return {
      ...rest,
      ...(showLevel && level ? { level } : {}),
      ...(keepAnswers && inputResponses ? { inputResponses } : {}),
    };
  };
  const change = (next: ConformanceProbe | undefined) => {
    if (
      !override &&
      next &&
      inherited &&
      onInheritedChange &&
      next.toolName === inherited.toolName &&
      sameArguments(next.arguments, inherited.arguments)
    ) {
      onInheritedChange(next);
      return;
    }
    // "Not set" on this check alone leaves it waiting for a tool, rather
    // than quietly falling back to the inherited one.
    onOverrideChange(next ? own(next) : { toolName: "" });
  };
  const [draftValid, setDraftValid] = useState(true);
  const valid = draftValid && (!override || override.toolName.trim() !== "");
  const onValidChangeRef = useRef(onValidChange);
  useEffect(() => {
    onValidChangeRef.current = onValidChange;
  });
  useEffect(() => {
    onValidChangeRef.current(valid);
  }, [valid]);
  useEffect(() => () => onValidChangeRef.current(true), []);
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={!override}
          onCheckedChange={(inherit) =>
            onOverrideChange(
              inherit ? undefined : own(effective ?? { toolName: "" }),
            )
          }
        />
        {inheritLabel}
      </label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <ConformanceProbeField
        probeKey={probeKey}
        tools={tools}
        probe={effective}
        onChange={change}
        onValidChange={setDraftValid}
        showLevel={showLevel}
        forCheck={checkTitle}
      />
    </div>
  );
}

/**
 * What a check or advice row shows under it for its probe: the field, under
 * the first picked one that calls the tool. The log level filtering advice,
 * when the logging check is picked too, shows its own field filled with the
 * logging check's tool, plus its log level. Nothing for a row that calls no
 * tool or is not picked.
 *
 * `onValidChange` names the probe, or the advice, whose input it validates.
 */
export function ProbeCheckExtra({
  checkId,
  checkTitle,
  isPicked,
  tools,
  probes,
  onProbesChange,
  onValidChange,
}: {
  checkId: string;
  checkTitle: (id: string) => string | undefined;
  isPicked: (id: string) => boolean;
  tools: ProbeTools;
  probes: ConformanceProbes;
  onProbesChange: (probes: ConformanceProbes) => void;
  onValidChange?: (
    part: ConformanceProbeKey | "answers" | typeof LOG_LEVEL_ADVICE,
    valid: boolean,
  ) => void;
}) {
  const key = probeKeyFor(checkId);
  if (!key || key === "tasksProbe" || !isPicked(checkId)) return null;
  const owner = PROBE_CHECKS[key].find(
    (id) => checkTitle(id) !== undefined && isPicked(id),
  );
  const probe = probes[key];
  const setProbe = (next: ConformanceProbe | undefined) => {
    const all = { ...probes };
    if (next) all[key] = next;
    else delete all[key];
    onProbesChange(all);
  };
  const showLevel = checkId === LOG_LEVEL_ADVICE;
  if (owner === checkId) {
    return (
      <ConformanceProbeField
        probeKey={key}
        tools={tools}
        probe={probe}
        onChange={setProbe}
        onValidChange={(valid) => onValidChange?.(key, valid)}
        showLevel={showLevel}
      />
    );
  }
  // Only the log level filtering advice shares its tool with an earlier row.
  if (!showLevel) return null;
  const ownerTitle = owner ? checkTitle(owner) : undefined;
  return (
    <CheckToolField
      probeKey={key}
      tools={tools}
      inherited={probe}
      override={probes.logLevelOverride}
      inheritLabel={
        ownerTitle
          ? `Use the tool from ${ownerTitle}`
          : "Use the logging check's tool"
      }
      checkTitle={checkTitle(checkId)}
      showLevel
      onOverrideChange={(next) => {
        const all = { ...probes };
        if (next) all.logLevelOverride = next;
        else delete all.logLevelOverride;
        onProbesChange(all);
      }}
      onInheritedChange={setProbe}
      onValidChange={(valid) => onValidChange?.(LOG_LEVEL_ADVICE, valid)}
    />
  );
}
