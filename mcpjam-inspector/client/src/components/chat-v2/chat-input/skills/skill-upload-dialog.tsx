import { useState, useRef, useCallback, useMemo } from "react";
import { Loader2, Upload, FolderOpen, File, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { uploadSkillFolder } from "@/lib/apis/mcp-skills-api";
import type { SkillResult } from "./skill-types";
import { isValidSkillName } from "../../../../../../shared/skill-types";
import { usePostHog } from "posthog-js/react";

interface SkillUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSkillCreated?: (skill: SkillResult) => void;
}

interface ParsedSkillInfo {
  name: string;
  description: string;
}

/**
 * Parse SKILL.md frontmatter to extract name and description
 */
function parseSkillMdFrontmatter(content: string): ParsedSkillInfo | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
  };
}

export function SkillUploadDialog({
  open,
  onOpenChange,
  onSkillCreated,
}: SkillUploadDialogProps) {
  const posthog = usePostHog();
  const [files, setFiles] = useState<File[]>([]);
  const [skillInfo, setSkillInfo] = useState<ParsedSkillInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setFiles([]);
    setSkillInfo(null);
    setError(null);
    setIsDragOver(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  };

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesArray = Array.from(fileList);

    // Find SKILL.md file
    const skillMdFile = filesArray.find(
      (f) =>
        f.name === "SKILL.md" || f.webkitRelativePath?.endsWith("/SKILL.md"),
    );

    if (!skillMdFile) {
      setError("No SKILL.md file found. Skills must contain a SKILL.md file.");
      return;
    }

    // Read and parse SKILL.md
    try {
      const content = await skillMdFile.text();
      const parsed = parseSkillMdFrontmatter(content);

      if (!parsed) {
        setError(
          "Invalid SKILL.md format. Must contain frontmatter with 'name' and 'description' fields.",
        );
        return;
      }

      if (!isValidSkillName(parsed.name)) {
        setError(
          `Invalid skill name "${parsed.name}". Name must be 1-64 characters, contain only lowercase letters, numbers, and hyphens, must not start or end with a hyphen, and must not contain consecutive hyphens.`,
        );
        return;
      }

      setSkillInfo(parsed);
      setFiles(filesArray);
      setError(null);
    } catch (err) {
      setError("Failed to read SKILL.md file.");
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
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

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const items = e.dataTransfer.items;
    const collectedFiles: File[] = [];

    // Helper to recursively read directory entries
    const readDirectory = async (
      entry: FileSystemDirectoryEntry,
    ): Promise<void> => {
      const reader = entry.createReader();

      // readEntries returns entries in batches, so we must call it
      // repeatedly until it returns an empty array to get all files
      const allEntries: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        allEntries.push(...batch);
      } while (batch.length > 0);

      for (const subEntry of allEntries) {
        if (subEntry.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            (subEntry as FileSystemFileEntry).file(resolve, reject);
          });
          // Preserve relative path
          const relativePath = subEntry.fullPath.replace(/^\//, "");
          Object.defineProperty(file, "webkitRelativePath", {
            value: relativePath,
            writable: false,
          });
          collectedFiles.push(file);
        } else if (subEntry.isDirectory) {
          await readDirectory(subEntry as FileSystemDirectoryEntry);
        }
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.webkitGetAsEntry?.();

      if (entry) {
        if (entry.isDirectory) {
          await readDirectory(entry as FileSystemDirectoryEntry);
        } else if (entry.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            (entry as FileSystemFileEntry).file(resolve, reject);
          });
          collectedFiles.push(file);
        }
      }
    }

    if (collectedFiles.length > 0) {
      processFiles(collectedFiles);
    }
  };

  const handleSubmit = async () => {
    if (!skillInfo || files.length === 0) return;

    setError(null);
    setIsLoading(true);

    try {
      const skill = await uploadSkillFolder(files, skillInfo.name);
      posthog.capture("skill_uploaded", {
        skill_name: skillInfo.name,
        file_count: files.length,
      });
      onSkillCreated?.(skill);
      handleOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const clearFiles = () => {
    setFiles([]);
    setSkillInfo(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isSubmitDisabled = useMemo(() => {
    return files.length === 0 || !skillInfo || isLoading;
  }, [files.length, skillInfo, isLoading]);

  // Get folder name from paths (for display)
  const folderName = useMemo(() => {
    if (files.length === 0) return null;
    const firstPath = files[0].webkitRelativePath || files[0].name;
    const parts = firstPath.split("/");
    return parts.length > 1 ? parts[0] : null;
  }, [files]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Skill</DialogTitle>
          <DialogDescription>
            Upload a skill folder containing a SKILL.md file. The folder will be
            saved to{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              ~/.mcpjam/skills/{skillInfo?.name || "{name}"}/
            </code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Hidden file input for folder selection */}
          <input
            ref={fileInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is not in the type definition
            webkitdirectory=""
            directory=""
            multiple
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Drop zone / file display */}
          {files.length === 0 ? (
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                isDragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                  <Upload className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">
                    Drop a skill folder here or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Folder must contain a SKILL.md file with name and
                    description frontmatter
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="border rounded-lg p-4 bg-muted/30">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <FolderOpen className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">
                      {folderName || skillInfo?.name || "Skill folder"}
                    </p>
                    {skillInfo && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {skillInfo.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {files.length} file{files.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearFiles}
                  className="flex-shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* File list preview */}
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Files:
                </p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {files.slice(0, 10).map((file, idx) => {
                    const displayPath =
                      file.webkitRelativePath?.split("/").slice(1).join("/") ||
                      file.name;
                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        <File className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{displayPath}</span>
                      </div>
                    );
                  })}
                  {files.length > 10 && (
                    <p className="text-xs text-muted-foreground pl-5">
                      ...and {files.length - 10} more
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Skill info display */}
          {skillInfo && (
            <div className="p-3 bg-muted/50 rounded-lg border">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Detected skill:
              </p>
              <div className="space-y-1">
                <p className="text-sm">
                  <span className="font-medium">Name:</span>{" "}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {skillInfo.name}
                  </code>
                </p>
                <p className="text-sm">
                  <span className="font-medium">Description:</span>{" "}
                  {skillInfo.description}
                </p>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              className="px-4"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitDisabled}
              className="px-4"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Skill
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
