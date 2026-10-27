/**
 * Where an operator names the tools the protocol suite may call.
 *
 * Two 2026-07-28 checks need a real tool call to observe anything: one that
 * emits logs and one that asks the user for input. The SDK never chooses a
 * tool itself, so this dialog is the only way a 2026 server can get those two
 * checks to run from the page. It SUGGESTS (read-only tools first, a warning
 * on tools that say they may modify data) and never picks on the operator's
 * behalf, for the same reason the SDK does not.
 */
import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Textarea } from "@mcpjam/design-system/textarea";
import { listTools } from "@/lib/apis/mcp-tools-api";
import type {
  ConformanceProbe,
  ConformanceProbeKey,
  ConformanceProbes,
} from "@/hooks/use-conformance-probes";

const NONE = "__none__";

const PROBE_COPY: Record<
  ConformanceProbeKey,
  { label: string; hint: string }
> = {
  logProbe: {
    label: "Tool that emits logs",
    hint: "Called up to 3 times: with no log level, with debug, and with warning. Pick one that writes logs and is safe to repeat.",
  },
  inputRequiredProbe: {
    label: "Tool that asks the user for input",
    hint: "Called once. Pick one that requests input before it finishes.",
  },
};

interface ToolOption {
  name: string;
  readOnly: boolean;
  destructive: boolean;
}

interface Draft {
  toolName: string;
  argumentsText: string;
}

function toDraft(probe: ConformanceProbe | undefined): Draft {
  return {
    toolName: probe?.toolName ?? NONE,
    argumentsText: probe?.arguments
      ? JSON.stringify(probe.arguments, null, 2)
      : "",
  };
}

/** A draft back to a probe, or an error to show beside its field. */
function fromDraft(
  draft: Draft,
): { probe?: ConformanceProbe; error?: string } {
  if (draft.toolName === NONE) return {};
  const text = draft.argumentsText.trim();
  if (!text) return { probe: { toolName: draft.toolName } };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Arguments must be a JSON object." };
    }
    return {
      probe: {
        toolName: draft.toolName,
        arguments: parsed as Record<string, unknown>,
      },
    };
  } catch {
    return { error: "Arguments are not valid JSON." };
  }
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

export function ConformanceProbeSettings({
  serverName,
  probes,
  onChange,
  disabled,
}: {
  serverName: string;
  probes: ConformanceProbes;
  onChange: (next: ConformanceProbes) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ToolOption[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<ConformanceProbeKey, Draft>>(
    () => ({
      logProbe: toDraft(probes.logProbe),
      inputRequiredProbe: toDraft(probes.inputRequiredProbe),
    }),
  );
  const [errors, setErrors] = useState<
    Partial<Record<ConformanceProbeKey, string>>
  >({});

  const configured = [probes.logProbe, probes.inputRequiredProbe].filter(
    Boolean,
  ).length;

  // Fresh drafts and a fresh tool list every time the dialog opens, so it
  // always starts from what is saved and from what the server lists now.
  useEffect(() => {
    if (!open) return;
    setDrafts({
      logProbe: toDraft(probes.logProbe),
      inputRequiredProbe: toDraft(probes.inputRequiredProbe),
    });
    setErrors({});
    setTools(null);
    setToolsError(null);
    let cancelled = false;
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
            })),
          ),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setToolsError(error instanceof Error ? error.message : String(error));
        setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, serverName, probes]);

  const save = () => {
    const next: ConformanceProbes = {};
    const nextErrors: Partial<Record<ConformanceProbeKey, string>> = {};
    for (const key of ["logProbe", "inputRequiredProbe"] as const) {
      const { probe, error } = fromDraft(drafts[key]);
      if (error) nextErrors[key] = error;
      if (probe) next[key] = probe;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onChange(next);
    setOpen(false);
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        Probe tools{configured > 0 ? ` · ${configured}` : ""}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Probe tools</DialogTitle>
            <DialogDescription>
              Two protocol checks for MCP 2026-07-28 need to call a tool on
              your server. Nothing is called unless you choose it here. Pick
              tools that are safe to run against this server.
            </DialogDescription>
          </DialogHeader>

          {toolsError ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              Couldn't list this server's tools: {toolsError}
            </p>
          ) : null}

          <div className="space-y-5">
            {(["logProbe", "inputRequiredProbe"] as const).map((key) => {
              const draft = drafts[key];
              const options = tools ?? [];
              // A saved tool the server no longer lists stays selectable,
              // so opening the dialog never silently drops a choice.
              const listed = options.some((tool) => tool.name === draft.toolName);
              const selected = options.find(
                (tool) => tool.name === draft.toolName,
              );
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`probe-${key}`}>{PROBE_COPY[key].label}</Label>
                  <Select
                    value={draft.toolName}
                    onValueChange={(toolName) =>
                      setDrafts((current) => ({
                        ...current,
                        [key]: { ...current[key], toolName },
                      }))
                    }
                    disabled={tools === null}
                  >
                    <SelectTrigger id={`probe-${key}`} className="w-full">
                      <SelectValue
                        placeholder={tools === null ? "Loading tools..." : "Not set"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not set</SelectItem>
                      {!listed && draft.toolName !== NONE ? (
                        <SelectItem value={draft.toolName}>
                          {draft.toolName} (not listed by the server)
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
                    {PROBE_COPY[key].hint}
                  </p>
                  {selected?.destructive ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      This tool says it may modify data. Choose it only if
                      calling it is safe on this server.
                    </p>
                  ) : null}
                  {draft.toolName !== NONE ? (
                    <Textarea
                      aria-label={`${PROBE_COPY[key].label} arguments`}
                      placeholder='Arguments as JSON, e.g. {"message": "hi"} (optional)'
                      value={draft.argumentsText}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [key]: {
                            ...current[key],
                            argumentsText: event.target.value,
                          },
                        }))
                      }
                      className="min-h-16 font-mono text-xs"
                    />
                  ) : null}
                  {errors[key] ? (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      {errors[key]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
