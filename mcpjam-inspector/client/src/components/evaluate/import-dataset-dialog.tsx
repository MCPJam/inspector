import { useCallback, useRef, useState } from "react";
import { File, FileJson, Upload, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

export const IMPORT_DATASET_UNAVAILABLE_MESSAGE =
  "Importing from a file isn't wired up yet — this is captured for now, not turned into cases.";

const ACCEPTED_EXTENSIONS = [".csv", ".json", ".md"];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

function isAcceptedFile(file: File) {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ImportDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once a valid file is picked. Wiring this up to real parsing is a follow-up. */
  onImport?: (file: File) => void;
}

export function ImportDatasetDialog({
  open,
  onOpenChange,
  onImport,
}: ImportDatasetDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setFile(null);
    setIsDragOver(false);
    setError(null);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  const acceptFile = useCallback((candidate: File) => {
    if (!isAcceptedFile(candidate)) {
      setError("Only CSV, JSON, or Markdown files are supported.");
      return;
    }
    if (candidate.size > MAX_FILE_SIZE_BYTES) {
      setError(
        `File is too large (${formatFileSize(candidate.size)}). Max size is ${formatFileSize(MAX_FILE_SIZE_BYTES)}.`,
      );
      return;
    }
    setError(null);
    setFile(candidate);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) acceptFile(selected);
    e.target.value = "";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) acceptFile(dropped);
  };

  const handleImportClick = () => {
    if (!file) return;
    if (onImport) {
      onImport(file);
    } else {
      toast.info(IMPORT_DATASET_UNAVAILABLE_MESSAGE);
    }
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload dataset</DialogTitle>
          <DialogDescription className="sr-only">
            Upload a CSV, JSON, or Markdown file to populate this suite's
            test cases.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="text-center">
            <h3 className="text-base font-semibold text-foreground">
              Import data
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              To populate this suite, manually{" "}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => fileInputRef.current?.click()}
              >
                upload a CSV, JSON, or Markdown file
              </button>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Supports .csv, .json, .md — up to{" "}
              {formatFileSize(MAX_FILE_SIZE_BYTES)}
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,.md,application/json,text/csv,text/markdown"
            onChange={handleFileChange}
            className="hidden"
          />

          {!file ? (
            <div
              className={cn(
                "flex min-h-40 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
                isDragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50",
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              data-testid="import-dataset-dropzone"
            >
              <FileJson className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Drag and drop a CSV, JSON, or Markdown file here,
                <br />
                or click to select
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <File className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium text-foreground"
                    title={file.name}
                  >
                    {file.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetForm}
                className="flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {error ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleImportClick}
              disabled={!file}
            >
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
