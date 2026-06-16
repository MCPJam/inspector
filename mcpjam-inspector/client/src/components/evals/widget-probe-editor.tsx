/**
 * Editor for `widget_probe` test cases (synthetic monitors).
 *
 * A probe pins one MCP tool call (server + tool + arguments), renders the
 * result in the browser harness during runs, and gates the iteration with
 * widget render checks. No LLM, no prompt turns, no models — so this is a
 * deliberately separate, much smaller surface than the prompt-case editor
 * (`TestTemplateEditor` dispatches here based on `testCase.caseType`).
 */

import { useEffect, useId, useMemo, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { toast } from "sonner";
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
import type { Predicate } from "@/shared/eval-matching";
import {
  probeConfigSchema,
  type ProbeConfig,
  MAX_PROBE_RENDER_TIMEOUT_MS,
  PROBE_TOOL_NAME_PLACEHOLDER,
} from "@/shared/probe-config";
import { ChecksSection, areAllChecksValid } from "./checks-section";
import type { RemoteServer } from "@/hooks/useProjects";

/** The create-flow placeholder reads as "unset" in the editor. */
function seedToolName(persisted: string | undefined): string {
  return persisted === PROBE_TOOL_NAME_PLACEHOLDER ? "" : (persisted ?? "");
}

interface WidgetProbeEditorProps {
  testCase: {
    _id: string;
    title: string;
    runs?: number;
    probeConfig?: ProbeConfig;
    predicates?: { mode: string; list: Predicate[] };
  };
  /** Effective suite server names (legacy env + host attachments). */
  suiteServers: string[];
  availableTools: Array<{
    name: string;
    description?: string;
    serverId?: string;
  }>;
  projectServers?: RemoteServer[];
  onBackToList?: () => void;
  updateTestCase: (args: {
    testCaseId: string;
    [key: string]: unknown;
  }) => Promise<unknown>;
}

export function WidgetProbeEditor({
  testCase,
  suiteServers,
  availableTools,
  projectServers,
  onBackToList,
  updateTestCase,
}: WidgetProbeEditorProps) {
  const [title, setTitle] = useState(testCase.title);
  const [runs, setRuns] = useState(testCase.runs ?? 1);
  const [serverName, setServerName] = useState(
    testCase.probeConfig?.serverName ?? suiteServers[0] ?? "",
  );
  const [toolName, setToolName] = useState(
    seedToolName(testCase.probeConfig?.toolName),
  );
  const [argsJson, setArgsJson] = useState(() =>
    JSON.stringify(testCase.probeConfig?.arguments ?? {}, null, 2),
  );
  const [argsError, setArgsError] = useState<string | null>(null);
  const [renderTimeoutMs, setRenderTimeoutMs] = useState<number | undefined>(
    testCase.probeConfig?.renderTimeoutMs,
  );
  const [checks, setChecks] = useState<Predicate[]>(
    testCase.predicates?.list ?? [{ type: "widgetRendered" }],
  );
  const [isSaving, setIsSaving] = useState(false);
  const runsId = useId();
  const timeoutId = useId();

  // Re-seed local state when the user navigates between cases without
  // unmounting the editor.
  useEffect(() => {
    setTitle(testCase.title);
    setRuns(testCase.runs ?? 1);
    setServerName(testCase.probeConfig?.serverName ?? suiteServers[0] ?? "");
    setToolName(seedToolName(testCase.probeConfig?.toolName));
    setArgsJson(JSON.stringify(testCase.probeConfig?.arguments ?? {}, null, 2));
    setArgsError(null);
    setRenderTimeoutMs(testCase.probeConfig?.renderTimeoutMs);
    setChecks(testCase.predicates?.list ?? [{ type: "widgetRendered" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testCase._id]);

  /** Stable project-server id for the chosen display name, when known. */
  const resolvedServerId = useMemo(() => {
    const match = (projectServers ?? []).find((s) => s.name === serverName);
    return match?._id;
  }, [projectServers, serverName]);

  const effectiveToolName = toolName;

  // Only offer tools that live on the selected server when per-tool server
  // attribution is available — a probe pinned to server A must not offer
  // server B's tools. Tools without a serverId (older inventories) stay
  // visible everywhere.
  const toolNames = useMemo(() => {
    const names = availableTools
      .filter(
        (t) =>
          !t.serverId || !resolvedServerId || t.serverId === resolvedServerId,
      )
      .map((t) => t.name);
    return Array.from(new Set(names));
  }, [availableTools, resolvedServerId]);

  const parsedArgs = useMemo(() => {
    try {
      const parsed = JSON.parse(argsJson || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "Expected a JSON object" };
      }
      return { value: parsed as Record<string, unknown> };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Invalid JSON" };
    }
  }, [argsJson]);

  const draftProbeConfig: ProbeConfig | null = useMemo(() => {
    if (!serverName || !effectiveToolName || !("value" in parsedArgs)) {
      return null;
    }
    return {
      ...(resolvedServerId ? { serverId: resolvedServerId } : {}),
      serverName,
      toolName: effectiveToolName,
      arguments: parsedArgs.value ?? {},
      ...(renderTimeoutMs ? { renderTimeoutMs } : {}),
    };
  }, [
    serverName,
    effectiveToolName,
    parsedArgs,
    resolvedServerId,
    renderTimeoutMs,
  ]);

  const probeConfigValid =
    draftProbeConfig !== null &&
    probeConfigSchema.safeParse(draftProbeConfig).success;
  const checksValid = areAllChecksValid(checks);
  const canSave =
    probeConfigValid && checksValid && title.trim().length > 0 && !isSaving;

  const handleSave = async () => {
    if (!draftProbeConfig || !canSave) return;
    setIsSaving(true);
    try {
      await updateTestCase({
        testCaseId: testCase._id,
        title: title.trim(),
        runs: Math.max(1, Math.min(10, Math.floor(runs || 1))),
        probeConfig: draftProbeConfig,
        predicates: { mode: "replace", list: checks },
      });
      toast.success("Render check saved");
    } catch (error) {
      console.error("Failed to save render check:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to save render check",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 min-w-0 flex-1 basis-0 overflow-y-auto overscroll-y-contain">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-6 pb-6 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {onBackToList ? (
                <button
                  type="button"
                  onClick={onBackToList}
                  className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  All cases
                </button>
              ) : null}
              <div className="flex items-center gap-2">
                <span className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Render check
                </span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-9 max-w-md text-sm font-medium"
                  placeholder="Render check name"
                  aria-label="Render check name"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Calls one MCP tool with pinned arguments, renders the widget in
                a headless browser, and applies the checks below — no model
                involved. Runs with the suite.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5"
              onClick={handleSave}
              disabled={!canSave}
              aria-busy={isSaving}
            >
              <Save className="h-3.5 w-3.5" aria-hidden />
              Save
            </Button>
          </div>

          <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold text-foreground">
              Pinned tool call
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-[11px]">Server</Label>
                {suiteServers.length > 0 ? (
                  <Select
                    value={serverName || undefined}
                    onValueChange={setServerName}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a server…" />
                    </SelectTrigger>
                    <SelectContent>
                      {suiteServers.map((name) => (
                        <SelectItem key={name} value={name} className="text-xs">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder="Server name"
                    className="h-8 text-xs"
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Tool</Label>
                {toolNames.length > 0 ? (
                  <Select
                    value={effectiveToolName || undefined}
                    onValueChange={setToolName}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a tool…" />
                    </SelectTrigger>
                    <SelectContent>
                      {toolNames.map((name) => (
                        <SelectItem key={name} value={name} className="text-xs">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={effectiveToolName}
                    onChange={(e) => setToolName(e.target.value)}
                    placeholder="e.g. show_map"
                    className="h-8 text-xs"
                  />
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Arguments (JSON)</Label>
              <textarea
                className={`min-h-[96px] w-full rounded-md border bg-background p-2 font-mono text-[11px] leading-tight ${
                  "error" in parsedArgs || argsError
                    ? "border-red-500/60"
                    : "border-border/60"
                }`}
                value={argsJson}
                onChange={(e) => {
                  setArgsJson(e.target.value);
                  setArgsError(null);
                }}
                spellCheck={false}
                aria-label="Probe arguments JSON"
              />
              {"error" in parsedArgs ? (
                <div className="text-[11px] text-red-600 dark:text-red-400">
                  {parsedArgs.error}
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={runsId} className="text-[11px]">
                  Iterations per run
                </Label>
                <Input
                  id={runsId}
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  value={runs}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setRuns(Math.floor(n));
                  }}
                  className="h-8 w-28 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={timeoutId} className="text-[11px]">
                  Render timeout ms (optional)
                </Label>
                <Input
                  id={timeoutId}
                  type="number"
                  min={1}
                  max={MAX_PROBE_RENDER_TIMEOUT_MS}
                  step={500}
                  value={renderTimeoutMs ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setRenderTimeoutMs(undefined);
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n)) return;
                    setRenderTimeoutMs(Math.floor(n));
                  }}
                  placeholder="Harness default"
                  className="h-8 w-36 text-xs"
                />
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <ChecksSection
              title="Checks"
              description="Checks gating this render check. Add widget checks (rendered / latency / console errors) or any other deterministic check."
              value={checks}
              onChange={setChecks}
              availableTools={toolNames}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
