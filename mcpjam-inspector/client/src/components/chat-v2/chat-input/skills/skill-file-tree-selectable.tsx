import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Image,
  Check,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkillFile } from "./skill-types";

interface SkillFileTreeSelectableProps {
  files: SkillFile[];
  selectedPaths: Set<string>;
  onToggleFile: (path: string, name: string) => void;
  loadingPath: string | null;
  disabledPaths?: Set<string>;
}

interface FileNodeProps {
  file: SkillFile;
  depth: number;
  selectedPaths: Set<string>;
  onToggleFile: (path: string, name: string) => void;
  loadingPath: string | null;
  disabledPaths: Set<string>;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
}

/**
 * Get icon for file based on extension/type
 */
function getFileIcon(file: SkillFile) {
  if (file.type === "directory") {
    return null;
  }

  const ext = file.extension?.toLowerCase() || "";
  const mime = file.mimeType || "";

  // Images
  if (mime.startsWith("image/")) {
    return <Image className="h-3 w-3 text-success" />;
  }

  // Code files
  if (
    [
      ".js",
      ".ts",
      ".tsx",
      ".jsx",
      ".py",
      ".rb",
      ".go",
      ".rs",
      ".java",
      ".c",
      ".cpp",
      ".h",
      ".sh",
      ".bash",
    ].includes(ext) ||
    mime.startsWith("text/x-")
  ) {
    return <FileCode className="h-3 w-3 text-info" />;
  }

  // Markdown files
  if ([".md", ".markdown"].includes(ext)) {
    return <FileText className="h-3 w-3 text-warning" />;
  }

  // Default file icon
  return <File className="h-3 w-3 text-muted-foreground" />;
}

/**
 * Format file size in human readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function FileNode({
  file,
  depth,
  selectedPaths,
  onToggleFile,
  loadingPath,
  disabledPaths,
  expandedPaths,
  toggleExpanded,
}: FileNodeProps) {
  const isDirectory = file.type === "directory";
  const isExpanded = expandedPaths.has(file.path);
  const isSelected = selectedPaths.has(file.path);
  const isMainFile = file.name === "SKILL.md";
  const isDisabled = disabledPaths.has(file.path);
  const isLoading = loadingPath === file.path;

  const handleClick = () => {
    if (isDisabled) return;
    if (isDirectory) {
      toggleExpanded(file.path);
    } else {
      onToggleFile(file.path, file.name);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 px-1 rounded-sm transition-colors text-[11px]",
          isDirectory
            ? "cursor-pointer hover:bg-muted/50"
            : isDisabled
              ? "cursor-default text-muted-foreground"
              : "cursor-pointer hover:bg-muted/50",
          isSelected && !isDisabled && "bg-primary/10",
          isMainFile && "text-foreground font-medium",
        )}
        style={{ paddingLeft: `${depth * 10 + 4}px` }}
        onClick={handleClick}
        aria-disabled={isDisabled}
      >
        {/* Selection indicator / Expand toggle */}
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          )
        ) : isLoading ? (
          <Loader2 className="h-3 w-3 flex-shrink-0 text-primary animate-spin" />
        ) : isDisabled ? (
          <Check className="h-3 w-3 flex-shrink-0 text-primary" />
        ) : isSelected ? (
          <Check className="h-3 w-3 flex-shrink-0 text-primary" />
        ) : (
          <div className="h-3 w-3 flex-shrink-0 rounded border border-muted-foreground/30" />
        )}

        {/* Icon */}
        {isDirectory ? (
          isExpanded ? (
            <FolderOpen className="h-3 w-3 text-warning flex-shrink-0" />
          ) : (
            <Folder className="h-3 w-3 text-warning flex-shrink-0" />
          )
        ) : (
          getFileIcon(file)
        )}

        {/* Name */}
        <span className="truncate flex-1">{file.name}</span>

        {/* Size badge for files */}
        {!isDirectory && file.size !== undefined && file.size > 0 && (
          <span className="text-[9px] text-muted-foreground/60 flex-shrink-0">
            {formatFileSize(file.size)}
          </span>
        )}
      </div>

      {/* Children (for directories) */}
      {isDirectory && isExpanded && file.children && (
        <div>
          {file.children.map((child: SkillFile) => (
            <FileNode
              key={child.path}
              file={child}
              depth={depth + 1}
              selectedPaths={selectedPaths}
              onToggleFile={onToggleFile}
              loadingPath={loadingPath}
              disabledPaths={disabledPaths}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillFileTreeSelectable({
  files,
  selectedPaths,
  onToggleFile,
  loadingPath,
  disabledPaths = new Set(),
}: SkillFileTreeSelectableProps) {
  // Start with root directories expanded
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    // Auto-expand first level directories
    files.forEach((file) => {
      if (file.type === "directory") {
        initial.add(file.path);
      }
    });
    return initial;
  });

  const toggleExpanded = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="py-2 text-[11px] text-muted-foreground text-center">
        No files found
      </div>
    );
  }

  return (
    <div className="py-0.5">
      {files.map((file) => (
        <FileNode
          key={file.path}
          file={file}
          depth={0}
          selectedPaths={selectedPaths}
          onToggleFile={onToggleFile}
          loadingPath={loadingPath}
          disabledPaths={disabledPaths}
          expandedPaths={expandedPaths}
          toggleExpanded={toggleExpanded}
        />
      ))}
    </div>
  );
}
