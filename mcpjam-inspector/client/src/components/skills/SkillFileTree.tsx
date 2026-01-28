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
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkillFile } from "@shared/skill-types";

interface SkillFileTreeProps {
  files: SkillFile[];
  selectedPath: string;
  onSelectFile: (path: string) => void;
  loading?: boolean;
}

interface FileNodeProps {
  file: SkillFile;
  depth: number;
  selectedPath: string;
  onSelectFile: (path: string) => void;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
}

/**
 * Get icon for file based on extension/type
 */
function getFileIcon(file: SkillFile) {
  if (file.type === "directory") {
    return null; // Handled separately for open/closed state
  }

  const ext = file.extension?.toLowerCase() || "";
  const mime = file.mimeType || "";

  // Images
  if (mime.startsWith("image/")) {
    return <Image className="h-3.5 w-3.5 text-success" />;
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
    return <FileCode className="h-3.5 w-3.5 text-info" />;
  }

  // Markdown files
  if ([".md", ".markdown"].includes(ext)) {
    return <FileText className="h-3.5 w-3.5 text-warning" />;
  }

  // Default file icon
  return <File className="h-3.5 w-3.5 text-muted-foreground" />;
}

function FileNode({
  file,
  depth,
  selectedPath,
  onSelectFile,
  expandedPaths,
  toggleExpanded,
}: FileNodeProps) {
  const isDirectory = file.type === "directory";
  const isExpanded = expandedPaths.has(file.path);
  const isSelected = selectedPath === file.path;
  const isMainFile = file.name === "SKILL.md";

  const handleClick = () => {
    if (isDirectory) {
      toggleExpanded(file.path);
    } else {
      onSelectFile(file.path);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-1 px-2 cursor-pointer rounded-sm transition-colors text-xs",
          isSelected
            ? "bg-primary/10 text-primary"
            : "hover:bg-muted/50 text-muted-foreground hover:text-foreground",
          isMainFile && !isSelected && "text-foreground font-medium",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
      >
        {/* Expand/collapse for directories */}
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" />
          )
        ) : (
          <span className="w-3" /> // Spacer for alignment
        )}

        {/* Icon */}
        {isDirectory ? (
          isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 text-warning flex-shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-warning flex-shrink-0" />
          )
        ) : (
          getFileIcon(file)
        )}

        {/* Name */}
        <span className="truncate">{file.name}</span>

        {/* Size badge for files */}
        {!isDirectory && file.size !== undefined && file.size > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground/70 flex-shrink-0">
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
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Format file size in human readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function SkillFileTree({
  files,
  selectedPath,
  onSelectFile,
  loading,
}: SkillFileTreeProps) {
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

  if (loading) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        Loading files...
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        No files found
      </div>
    );
  }

  return (
    <div className="py-1">
      {files.map((file) => (
        <FileNode
          key={file.path}
          file={file}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          expandedPaths={expandedPaths}
          toggleExpanded={toggleExpanded}
        />
      ))}
    </div>
  );
}
