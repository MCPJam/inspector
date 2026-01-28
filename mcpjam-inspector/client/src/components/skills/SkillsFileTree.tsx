import { useState, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Image,
  SquareSlash,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkillFile, SkillListItem } from "@shared/skill-types";

interface SkillsFileTreeProps {
  skills: SkillListItem[];
  skillFiles: Record<string, SkillFile[]>; // skill name -> files
  loadingSkills: boolean;
  loadingFiles: Record<string, boolean>; // skill name -> loading state
  selectedSkillName: string;
  selectedFilePath: string;
  onSelectSkill: (name: string) => void;
  onSelectFile: (skillName: string, filePath: string) => void;
  onExpandSkill: (name: string) => void;
}

interface SkillNodeProps {
  skill: SkillListItem;
  files: SkillFile[];
  isExpanded: boolean;
  isLoading: boolean;
  isSelected: boolean;
  selectedFilePath: string;
  onToggle: () => void;
  onSelectFile: (path: string) => void;
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
    return null;
  }

  const ext = file.extension?.toLowerCase() || "";
  const mime = file.mimeType || "";

  if (mime.startsWith("image/")) {
    return <Image className="h-3.5 w-3.5 text-success" />;
  }

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

  if ([".md", ".markdown"].includes(ext)) {
    return <FileText className="h-3.5 w-3.5 text-warning" />;
  }

  return <File className="h-3.5 w-3.5 text-muted-foreground" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" />
          )
        ) : (
          <span className="w-3" />
        )}

        {isDirectory ? (
          isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 text-warning flex-shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-warning flex-shrink-0" />
          )
        ) : (
          getFileIcon(file)
        )}

        <span className="truncate">{file.name}</span>

        {!isDirectory && file.size !== undefined && file.size > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground/70 flex-shrink-0">
            {formatFileSize(file.size)}
          </span>
        )}
      </div>

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

function SkillNode({
  skill,
  files,
  isExpanded,
  isLoading,
  isSelected,
  selectedFilePath,
  onToggle,
  onSelectFile,
}: SkillNodeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    files.forEach((file) => {
      if (file.type === "directory") {
        initial.add(file.path);
      }
    });
    return initial;
  });

  // Update expanded paths when files change
  useEffect(() => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      files.forEach((file) => {
        if (file.type === "directory" && !prev.has(file.path)) {
          next.add(file.path);
        }
      });
      return next;
    });
  }, [files]);

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

  return (
    <div>
      {/* Skill header row */}
      <div
        className={cn(
          "flex items-center gap-1.5 py-1.5 px-2 cursor-pointer rounded-sm transition-colors text-xs",
          isSelected && !selectedFilePath
            ? "bg-primary/10 text-primary"
            : "hover:bg-muted/50",
        )}
        onClick={onToggle}
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}

        <SquareSlash className="h-3.5 w-3.5 text-primary flex-shrink-0" />

        <span
          className={cn(
            "truncate font-medium",
            isSelected && "text-foreground",
          )}
        >
          {skill.name}
        </span>
      </div>

      {/* Expanded content: files */}
      {isExpanded && (
        <div>
          {isLoading ? (
            <div
              className="py-2 px-2 text-[10px] text-muted-foreground"
              style={{ paddingLeft: "32px" }}
            >
              Loading...
            </div>
          ) : files.length === 0 ? (
            <div
              className="py-2 px-2 text-[10px] text-muted-foreground"
              style={{ paddingLeft: "32px" }}
            >
              No files
            </div>
          ) : (
            files.map((file) => (
              <FileNode
                key={file.path}
                file={file}
                depth={1}
                selectedPath={selectedFilePath}
                onSelectFile={onSelectFile}
                expandedPaths={expandedPaths}
                toggleExpanded={toggleExpanded}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SkillsFileTree({
  skills,
  skillFiles,
  loadingSkills,
  loadingFiles,
  selectedSkillName,
  selectedFilePath,
  onSelectSkill,
  onSelectFile,
  onExpandSkill,
}: SkillsFileTreeProps) {
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  // Auto-expand newly selected skill
  useEffect(() => {
    if (selectedSkillName && !expandedSkills.has(selectedSkillName)) {
      setExpandedSkills((prev) => new Set(prev).add(selectedSkillName));
      onExpandSkill(selectedSkillName);
    }
  }, [selectedSkillName]);

  const toggleSkillExpanded = (skillName: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) {
        next.delete(skillName);
      } else {
        next.add(skillName);
        // Trigger file loading when expanding
        onExpandSkill(skillName);
      }
      return next;
    });
    onSelectSkill(skillName);
  };

  const handleFileSelect = (skillName: string, filePath: string) => {
    onSelectFile(skillName, filePath);
  };

  if (loadingSkills) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        Loading skills...
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        No skills available
      </div>
    );
  }

  return (
    <div className="py-1">
      {skills.map((skill) => (
        <SkillNode
          key={skill.name}
          skill={skill}
          files={skillFiles[skill.name] || []}
          isExpanded={expandedSkills.has(skill.name)}
          isLoading={loadingFiles[skill.name] || false}
          isSelected={selectedSkillName === skill.name}
          selectedFilePath={
            selectedSkillName === skill.name ? selectedFilePath : ""
          }
          onToggle={() => toggleSkillExpanded(skill.name)}
          onSelectFile={(path) => handleFileSelect(skill.name, path)}
        />
      ))}
    </div>
  );
}
