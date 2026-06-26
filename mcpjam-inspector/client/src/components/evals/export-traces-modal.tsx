import { useState } from "react";
import { useAction } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { Label } from "@mcpjam/design-system/label";
import { Loader2 } from "lucide-react";
import { downloadTextFile } from "@/lib/download-text-file";

// Opaque to the client — we only ever concatenate and serialize these.
type OtlpResourceSpans = unknown;
type Scope = "run" | "project";

// Safety bound on the project pagination loop (the action always reports isDone;
// this just guards against a pathological non-terminating cursor).
const MAX_PROJECT_PAGES = 1000;

type ExportSessionTraces = (args: {
  projectId: string;
  chatSessionIds: string[];
  includeContent: boolean;
}) => Promise<{ resourceSpans: OtlpResourceSpans[] }>;

type ExportProjectTracesPage = (args: {
  projectId: string;
  includeContent: boolean;
  cursor: string | null;
}) => Promise<{
  resourceSpans: OtlpResourceSpans[];
  nextCursor: string | null;
  isDone: boolean;
}>;

/**
 * Download a run's (or the whole project's) traces as OTLP/JSON with
 * OpenInference + `mcp.app.*` semantic conventions. Content/artifacts are
 * redacted by default (matches the backend default); the user opts in.
 */
export function ExportTracesModal({
  open,
  onOpenChange,
  projectId,
  runChatSessionIds,
  runLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null | undefined;
  runChatSessionIds: string[];
  runLabel?: string | null;
}) {
  const exportSessionTraces = useAction(
    "traceExport:exportSessionTraces" as any
  ) as unknown as ExportSessionTraces;
  const exportProjectTracesPage = useAction(
    "traceExport:exportProjectTracesPage" as any
  ) as unknown as ExportProjectTracesPage;

  const hasRun = runChatSessionIds.length > 0;
  const [scope, setScope] = useState<Scope>(hasRun ? "run" : "project");
  const [includeContent, setIncludeContent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveScope: Scope = hasRun ? scope : "project";

  const handleExport = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      let resourceSpans: OtlpResourceSpans[] = [];
      if (effectiveScope === "run") {
        const res = await exportSessionTraces({
          projectId,
          chatSessionIds: runChatSessionIds,
          includeContent,
        });
        resourceSpans = res.resourceSpans;
      } else {
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
          const result = await exportProjectTracesPage({
            projectId,
            includeContent,
            cursor,
          });
          resourceSpans = resourceSpans.concat(result.resourceSpans);
          if (result.isDone) break;
          cursor = result.nextCursor;
        }
      }

      const body = JSON.stringify({ resourceSpans }, null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadTextFile(
        `mcpjam-traces-${effectiveScope}-${stamp}.json`,
        body,
        "application/json"
      );
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export traces</DialogTitle>
          <DialogDescription>
            Download as OTLP JSON (OpenInference + MCP Apps conventions) for
            Arize Phoenix, Datadog, or any OTLP-compatible backend.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              Scope
            </Label>
            <RadioGroup
              value={effectiveScope}
              onValueChange={(v) => setScope(v as Scope)}
              className="gap-2"
            >
              <label
                className="flex items-center gap-2 text-sm data-[disabled]:opacity-50"
                data-disabled={!hasRun ? "" : undefined}
              >
                <RadioGroupItem value="run" disabled={!hasRun} />
                {runLabel ? `This run · ${runLabel}` : "This run"}
                {!hasRun ? (
                  <span className="text-xs text-muted-foreground">
                    (no recorded sessions)
                  </span>
                ) : null}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="project" />
                Whole project
              </label>
            </RadioGroup>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={includeContent}
              onCheckedChange={(c) => setIncludeContent(c === true)}
              className="mt-0.5"
            />
            <span>
              Include content &amp; artifacts
              <span className="block text-xs text-muted-foreground">
                Prompts, outputs, tool args/results, and screenshots. Off by
                default — these can contain secrets.
              </span>
            </span>
          </label>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={busy || !projectId}>
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Exporting…
              </>
            ) : (
              "Download"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
