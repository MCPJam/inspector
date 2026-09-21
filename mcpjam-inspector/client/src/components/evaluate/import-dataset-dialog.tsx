import { ERROR_MESSAGES } from "@/lib/error-messages";
import { useEffect, useRef, useState } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { authoringRequest } from "@/lib/apis/eval-authoring-api";
import { followAuthoringJob } from "@/lib/mcpjam-agent/eval-workspace";
import { describeMCPJamLimitMessage } from "@/lib/mcpjam-limit";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { toast } from "@/lib/toast";
import { extractMarkdownCases } from "@/lib/apis/markdown-case-import-api";
import { MAX_MARKDOWN_BYTES } from "@/shared/markdown-case-import";
import { stageMarkdownDrafts } from "@/lib/mcpjam-agent/eval-workspace";

interface ImportDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  suiteId: string;
}
export function ImportDatasetDialog({
  open,
  onOpenChange,
  projectId,
  suiteId,
}: ImportDatasetDialogProps) {
  const sharedAuthoring =
    useFeatureFlagEnabled("eval-authoring-import-v1") === true;
  const [file, setFile] = useState<File | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "extracting">("idle");
  // The limit dialog already opened on the refusal; the inline line only has
  // to say why the import stopped. The wire sentence ("… Use BYOK or try
  // again tomorrow.") is authored by a Convex backend outside this repo, so
  // matching the other two case-creation surfaces has to happen here.
  const errorText = error ? describeMCPJamLimitMessage(error) ?? error : null;
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const startIdentity = useRef({ file: null as File | null, key: "" });
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    busy.current = false;
    setFile(null);
    setWarnings([]);
    setError(null);
    setPhase("idle");
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [open, projectId, suiteId]);

  const close = () => {
    generation.current++;
    controller.current?.abort();
    onOpenChange(false);
  };
  const selectFile = (files: FileList | null) => {
    setWarnings([]);
    setFile(null);
    setError(null);
    if (!files?.length) return;
    if (files.length !== 1) {
      setError(ERROR_MESSAGES.chooseOneMarkdownFile);
      return;
    }
    const candidate = files[0];
    if (!/\.md$/i.test(candidate.name)) {
      setError(ERROR_MESSAGES.onlyMarkdownMdFilesAreSupported);
      return;
    }
    if (!candidate.size) {
      setError(ERROR_MESSAGES.theFileIsEmpty);
      return;
    }
    if (candidate.size > MAX_MARKDOWN_BYTES) {
      setError(ERROR_MESSAGES.splitTheFileIntoDocumentsOfAtMost100Kb);
      return;
    }
    setFile(candidate);
  };
  const extract = async () => {
    if (!file || busy.current) return;
    busy.current = true;
    setPhase("extracting");
    setError(null);
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!markdown.trim()) throw new Error("The file is empty.");
      if (current !== generation.current) return;
      if (sharedAuthoring) {
        const result = await authoringRequest(
          {
            operation: "start",
            input: {
              source: "markdown",
              markdown,
              fileName: file.name,
              projectId,
              suiteId,
              requestKey: (() => {
                if (startIdentity.current.file !== file)
                  startIdentity.current = { file, key: crypto.randomUUID() };
                return startIdentity.current.key;
              })(),
            },
          },
          abort.signal,
        );
        // The job is started either way, but a response that lost its race
        // must not close a dialog the user already reopened on another suite.
        if (current !== generation.current) return;
        void followAuthoringJob({ projectId, suiteId }, result.jobId);
        onOpenChange(false);
        return;
      }
      const response = await extractMarkdownCases(
        { markdown, fileName: file.name, projectId, suiteId },
        abort.signal,
      );
      if (current !== generation.current) return;
      if (response.drafts.length) {
        stageMarkdownDrafts(
          { projectId, suiteId },
          response.drafts,
          response.warnings,
        );
        toast.success("Imported drafts are ready to review.");
        onOpenChange(false);
      } else {
        setWarnings(response.warnings);
        setError(
          ERROR_MESSAGES.noTestCasesWereExtractedReviewTheWarningsOrChooseAnotherFile,
        );
      }
    } catch (e) {
      if (current === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : ERROR_MESSAGES.couldNotReadOrExtractThisFile,
        );
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPhase("idle");
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
        className="max-h-[85vh] gap-6 overflow-y-auto p-6 sm:max-w-2xl"
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="text-xl font-semibold">
            Import test cases
          </DialogTitle>
          <DialogDescription>
            AI turns your Markdown into draft test cases. Review them before
            saving.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <input
            ref={input}
            tabIndex={-1}
            aria-label="Markdown file"
            type="file"
            accept=".md,text/markdown"
            className="sr-only"
            disabled={phase !== "idle"}
            onChange={(event) => {
              selectFile(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={phase !== "idle"}
            className="min-h-24 w-full rounded-lg border border-dashed border-border px-6 py-8 text-sm transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            data-testid="import-dataset-dropzone"
            onClick={() => input.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (phase === "idle") selectFile(event.dataTransfer.files);
            }}
          >
            Drop one Markdown file here or click to select. Up to 100 KB.
          </button>
          {file && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </span>
              <Button
                variant="ghost"
                disabled={phase !== "idle"}
                onClick={() => {
                  setFile(null);
                  setWarnings([]);
                  setError(null);
                }}
              >
                Remove file
              </Button>
            </div>
          )}
        </div>
        {warnings.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        )}
        {errorText && (
          <p
            role="alert"
            className="rounded bg-destructive/10 p-3 text-sm text-destructive"
          >
            {errorText}
          </p>
        )}
        {phase === "extracting" && <p role="status">Extracting cases…</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={extract} disabled={!file || phase !== "idle"}>
            Extract cases
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
