/**
 * The title rows of the steps editor's pages, the New case banner and the
 * delete dialog.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Download,
  ListChecks,
  Play,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "@/components/evals/constants";

/** Test case and Edit Test Case: editable title, then Delete, Save, evaluators and Run. */
export function CaseHeader({
  title,
  savedTitle,
  onTitleChange,
  previewToggle,
  dirty,
  readOnly,
  runDisabledReason,
  onDelete,
  onSave,
  onOpenEvaluators,
  onRun,
}: {
  title: string;
  savedTitle: string;
  onTitleChange: (title: string) => void;
  previewToggle: ReactNode;
  dirty: boolean;
  readOnly: boolean;
  runDisabledReason: string | null;
  onDelete: () => void;
  onSave: () => void;
  onOpenEvaluators: () => void;
  onRun: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const before = useRef("");
  const stop = () => {
    setEditing(false);
    if (!title.trim()) onTitleChange(savedTitle);
  };
  return (
    <div className="border-b border-border px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[min(100%,12rem)] items-center gap-2">
          {editing ? (
            <input
              type="text"
              value={title}
              aria-label="Test case title"
              autoFocus
              onChange={(event) => onTitleChange(event.target.value)}
              onBlur={stop}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  onTitleChange(before.current);
                  setEditing(false);
                }
              }}
              className="w-full min-w-0 bg-transparent px-0 py-0 text-base font-semibold tracking-tight focus:outline-none"
            />
          ) : (
            <button
              type="button"
              className="min-w-0 text-left"
              disabled={readOnly}
              onClick={() => {
                before.current = title;
                setEditing(true);
              }}
            >
              <h2 className="text-base font-semibold tracking-tight transition-opacity hover:opacity-80">
                {title || savedTitle}
              </h2>
            </button>
          )}
          {previewToggle}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
          {readOnly ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 shrink-0 p-0 hover:bg-destructive/10 hover:text-destructive"
              aria-label="Delete test case"
              title="Delete test case"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )}
          {dirty && !readOnly ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onSave}
            >
              <Save className="mr-2 h-3.5 w-3.5" aria-hidden />
              Save
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenEvaluators}
          >
            <ListChecks className="size-3.5" aria-hidden />
            Test Case Evaluators
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={runDisabledReason !== null}
            title={runDisabledReason ?? undefined}
            onClick={onRun}
          >
            <Play className="size-3.5 fill-current" aria-hidden />
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}

/** New case: a large title, then Save case and Export. */
export function NewCaseHeader({
  title,
  onTitleChange,
  previewToggle,
  saveDisabled,
  onSave,
  onExport,
}: {
  title: string;
  onTitleChange: (title: string) => void;
  previewToggle: ReactNode;
  saveDisabled: boolean;
  onSave: () => void;
  onExport: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        aria-label="Draft case title"
        placeholder="Untitled test case"
        className="min-w-0 flex-1 basis-64 bg-transparent text-2xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground"
      />
      {previewToggle}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          disabled={saveDisabled}
          onClick={onSave}
        >
          Save case
        </Button>
        <Button type="button" size="sm" className="h-9" onClick={onExport}>
          <Download className="size-3.5" aria-hidden />
          Export
        </Button>
      </div>
    </div>
  );
}

export function SuiteSettingsBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <Settings2
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="text-sm font-semibold text-foreground">
        Suite settings apply
      </span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="ml-auto h-auto gap-1 px-0 text-sm"
        onClick={onOpen}
      >
        Open suite settings
        <ArrowUpRight className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

export function DeleteCaseDialog({
  open,
  title,
  deleting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  deleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !deleting && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-5 text-destructive" aria-hidden />
            Delete test case
          </DialogTitle>
          <DialogDescription>
            Delete “{title || "Untitled test case"}”? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
