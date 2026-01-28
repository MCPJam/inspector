import { X, ChevronDown, ChevronUp, SquareSlash, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import type { SkillResult, SelectedSkillFile, SkillFile } from "./skill-types";
import { listSkillFiles, readSkillFile } from "@/lib/apis/mcp-skills-api";
import { SkillFileTreeSelectable } from "./skill-file-tree-selectable";

interface SkillResultCardProps {
  skillResult: SkillResult;
  onRemove: () => void;
  onUpdate?: (updatedSkill: SkillResult) => void;
}

export function SkillResultCard({
  skillResult,
  onRemove,
  onUpdate,
}: SkillResultCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track selected file paths (SKILL.md is always selected by default via content)
  const selectedPaths = new Set(
    skillResult.selectedFiles?.map((f) => f.path) || [],
  );

  // Fetch files when expanded
  useEffect(() => {
    if (isExpanded && files.length === 0 && !loading) {
      setLoading(true);
      setError(null);
      listSkillFiles(skillResult.name)
        .then((fetchedFiles) => {
          setFiles(fetchedFiles);
        })
        .catch((err) => {
          setError(err.message || "Failed to load files");
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [isExpanded, skillResult.name, files.length, loading]);

  // Handle file selection toggle
  const handleFileToggle = useCallback(
    async (filePath: string, fileName: string) => {
      if (!onUpdate) return;

      // Don't allow toggling SKILL.md - it's always included via content
      if (fileName === "SKILL.md") return;

      const isSelected = selectedPaths.has(filePath);

      if (isSelected) {
        // Remove file from selection
        const newSelectedFiles =
          skillResult.selectedFiles?.filter((f) => f.path !== filePath) || [];
        onUpdate({
          ...skillResult,
          selectedFiles:
            newSelectedFiles.length > 0 ? newSelectedFiles : undefined,
        });
      } else {
        // Add file to selection - need to fetch content first
        setLoadingFile(filePath);
        try {
          const fileContent = await readSkillFile(skillResult.name, filePath);
          if (!fileContent.isText || !fileContent.content) {
            // Skip non-text files
            setLoadingFile(null);
            return;
          }

          const newFile: SelectedSkillFile = {
            path: filePath,
            name: fileName,
            content: fileContent.content,
            mimeType: fileContent.mimeType,
          };

          onUpdate({
            ...skillResult,
            selectedFiles: [...(skillResult.selectedFiles || []), newFile],
          });
        } catch (err) {
          console.error("Failed to load file:", err);
        } finally {
          setLoadingFile(null);
        }
      }
    },
    [skillResult, selectedPaths, onUpdate],
  );

  // Count of additional files selected (not counting SKILL.md which is always included)
  const additionalFilesCount = skillResult.selectedFiles?.length || 0;

  return (
    <div className="inline-flex flex-col rounded-md border border-border bg-muted/50 text-xs hover:bg-muted/70 transition-colors">
      {/* Compact header */}
      <div
        className="group inline-flex items-center gap-1.5 px-2 py-1 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <SquareSlash size={12} className="text-primary shrink-0" />
          <span className="font-small text-foreground truncate max-w-[180px]">
            {skillResult.name}
          </span>
          {additionalFilesCount > 0 && (
            <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">
              +{additionalFilesCount} files
            </span>
          )}
          {isExpanded ? (
            <ChevronUp size={12} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown size={12} className="text-muted-foreground shrink-0" />
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex-shrink-0 rounded-sm opacity-60 hover:opacity-100 transition-opacity hover:bg-accent p-0.5 cursor-pointer"
          aria-label={`Remove ${skillResult.name}`}
        >
          <X size={12} className="text-muted-foreground" />
        </button>
      </div>

      {/* Expanded details with file tree */}
      {isExpanded && (
        <div className="border-t border-border px-2 py-2 space-y-2 max-w-[400px]">
          {/* Description */}
          {skillResult.description && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Description:
              </span>
              <p className="text-[11px] text-foreground/80 leading-relaxed">
                {skillResult.description}
              </p>
            </div>
          )}

          {/* Files section */}
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Files:
            </span>

            {loading ? (
              <div className="flex items-center gap-2 py-2 text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                <span className="text-[11px]">Loading files...</span>
              </div>
            ) : error ? (
              <div className="py-2 text-[11px] text-destructive">{error}</div>
            ) : (
              <div className="max-h-[200px] overflow-y-auto">
                <SkillFileTreeSelectable
                  files={files}
                  selectedPaths={selectedPaths}
                  onToggleFile={handleFileToggle}
                  loadingPath={loadingFile}
                  disabledPaths={new Set(["SKILL.md"])}
                />
              </div>
            )}
          </div>

          {/* Hint */}
          {onUpdate && !loading && !error && files.length > 0 && (
            <p className="text-[10px] text-muted-foreground/70 italic">
              Click files to add/remove from context. SKILL.md is always
              included.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
