/**
 * The tool a check that must call one may use, set right under that check in
 * the check list: tool inputs live with the checks they serve, not in a
 * separate dialog.
 *
 * It SUGGESTS (read-only tools first, a warning on tools that say they may
 * modify data) and never picks for the operator, for the same reason the SDK
 * does not: nothing a server advertises says a tool is safe to call.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { listTools } from "@/lib/apis/mcp-tools-api";
import { ToolCallArgsEditor } from "@/components/evals/checks-section";
import {
  PROBE_CHECKS,
  probeKeyFor,
  type ConformanceProbe,
  type ConformanceProbeKey,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";

const NONE = "__none__";

const PROBE_COPY: Record<ConformanceProbeKey, { label: string; hint: string }> =
  {
    logProbe: {
      label: "Tool that emits logs",
      hint: "Called up to 3 times: without a log level, at debug, and at warning. Pick one that writes logs and is safe to repeat.",
    },
    inputRequiredProbe: {
      label: "Tool that asks for input",
      hint: "Called once. Pick one that asks the user for input before it finishes.",
    },
  };

interface ToolOption {
  name: string;
  readOnly: boolean;
  destructive: boolean;
  /** The tool's input schema properties: the argument names to offer. */
  argProperties?: Record<string, unknown>;
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

/** The server's tools, listed once per field. */
function useServerTools(serverName: string) {
  const [tools, setTools] = useState<ToolOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTools(null);
    setError(null);
    listTools({ serverId: serverName })
      .then((result) => {
        if (cancelled) return;
        setTools(
          sortForSafety(
            (result.tools ?? []).map((tool) => ({
              name: tool.name,
              readOnly: tool.annotations?.readOnlyHint === true,
              destructive:
                tool.annotations?.readOnlyHint !== true &&
                tool.annotations?.destructiveHint !== false,
              argProperties: tool.inputSchema?.properties,
            })),
          ),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverName]);
  return { tools, error };
}

export function ConformanceProbeField({
  probeKey,
  serverName,
  probe,
  onChange,
  onValidChange,
}: {
  probeKey: ConformanceProbeKey;
  serverName: string;
  probe: ConformanceProbe | undefined;
  onChange: (probe: ConformanceProbe | undefined) => void;
  /** False while the Raw JSON box holds text that does not parse. */
  onValidChange?: (valid: boolean) => void;
}) {
  const id = useId();
  const { tools, error: toolsError } = useServerTools(serverName);
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
  const toolName = probe?.toolName ?? NONE;
  const options = tools ?? [];
  // A saved tool the server no longer lists stays selectable, so opening the
  // list never silently drops a choice.
  const listed = options.some((tool) => tool.name === toolName);
  const selected = options.find((tool) => tool.name === toolName);
  const copy = PROBE_COPY[probeKey];

  // Another tool takes other arguments, so a new pick starts with none.
  const changeTool = (next: string) =>
    onChange(next === NONE ? undefined : { toolName: next });

  const changeArguments = (args: Record<string, unknown>) =>
    onChange({
      toolName,
      ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
    });

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
      <Label htmlFor={id} className="text-xs">
        {copy.label}
      </Label>
      <Select
        value={toolName}
        onValueChange={changeTool}
        disabled={tools === null}
      >
        <SelectTrigger id={id} className="h-8 w-full text-xs">
          <SelectValue
            placeholder={tools === null ? "Loading tools..." : "Not set"}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not set</SelectItem>
          {!listed && toolName !== NONE ? (
            <SelectItem value={toolName}>
              {toolName} (not listed by the server)
            </SelectItem>
          ) : null}
          {options.map((tool) => (
            <SelectItem key={tool.name} value={tool.name}>
              {tool.name}
              {tool.readOnly
                ? " · read-only"
                : tool.destructive
                  ? " · may modify data"
                  : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {toolName === NONE
          ? "Without a tool, this check reports that it could not run."
          : copy.hint}
      </p>
      {toolsError ? (
        <p className="text-xs text-destructive">
          Couldn't list this server's tools: {toolsError}
        </p>
      ) : null}
      {selected?.destructive ? (
        <p className="text-xs text-warning">
          This tool says it may modify data. Choose it only if calling it is
          safe on this server.
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
    </div>
  );
}

/**
 * What a protocol check row shows under it for its probe: the field, under
 * the first picked check that calls the tool, and a pointer to it under the
 * others. Nothing for a check that calls no tool or is not picked.
 */
export function ProbeCheckExtra({
  checkId,
  checkTitle,
  isPicked,
  serverName,
  probes,
  onProbesChange,
  onValidChange,
}: {
  checkId: string;
  checkTitle: (id: string) => string | undefined;
  isPicked: (id: string) => boolean;
  serverName: string;
  probes: ConformanceProbes;
  onProbesChange: (probes: ConformanceProbes) => void;
  onValidChange?: (key: ConformanceProbeKey, valid: boolean) => void;
}) {
  const key = probeKeyFor(checkId);
  if (!key || !isPicked(checkId)) return null;
  const owner = PROBE_CHECKS[key].find(
    (id) => checkTitle(id) !== undefined && isPicked(id),
  );
  if (owner !== checkId) {
    return (
      <p className="text-xs text-muted-foreground">
        Calls the tool set under {owner ? checkTitle(owner) : "the check above"}
        .
      </p>
    );
  }
  return (
    <ConformanceProbeField
      probeKey={key}
      serverName={serverName}
      probe={probes[key]}
      onChange={(probe) => {
        const next = { ...probes };
        if (probe) next[key] = probe;
        else delete next[key];
        onProbesChange(next);
      }}
      onValidChange={(valid) => onValidChange?.(key, valid)}
    />
  );
}
