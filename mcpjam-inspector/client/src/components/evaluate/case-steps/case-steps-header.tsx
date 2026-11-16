/** The test case page's title row and its delete dialog. */
import { useRef, useState } from "react";
import { ListChecks, Play, Save, Trash2 } from "lucide-react";
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

/** Editable title, then Delete, Save, Test Case Evaluators and Run. Delete and Run show only when the page can do them. */
export function CaseHeader({
  title,
  savedTitle,
  onTitleChange,
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
  dirty: boolean;
  readOnly: boolean;
  runDisabledReason: string | null;
  onDelete?: () => void;
  onSave: () => void;
  onOpenEvaluators: () => void;
  onRun?: () => void;
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
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
          {readOnly || !onDelete ? null : (
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
          {onRun ? (
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
          ) : null}
        </div>
      </div>
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
