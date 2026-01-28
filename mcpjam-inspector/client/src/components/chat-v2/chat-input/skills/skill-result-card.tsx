import { X, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { useState } from "react";
import type { SkillResult } from "./skill-types";

interface SkillResultCardProps {
  skillResult: SkillResult;
  onRemove: () => void;
}

export function SkillResultCard({ skillResult, onRemove }: SkillResultCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Get a preview of the content (first 200 chars)
  const contentPreview =
    skillResult.content.length > 200
      ? `${skillResult.content.slice(0, 200)}...`
      : skillResult.content;

  return (
    <div className="inline-flex flex-col rounded-md border border-border bg-muted/50 text-xs hover:bg-muted/70 transition-colors">
      {/* Compact header */}
      <div
        className="group inline-flex items-center gap-1.5 px-2 py-1 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Sparkles size={12} className="text-primary shrink-0" />
          <span className="font-small text-foreground truncate max-w-[180px]">
            {skillResult.name}
          </span>
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

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-border px-2 py-2 space-y-2 max-w-[400px]">
          {/* Path badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Path:
            </span>
            <span className="text-[11px] font-mono bg-accent px-1.5 py-0.5 rounded">
              {skillResult.path}
            </span>
          </div>

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

          {/* Content preview */}
          {contentPreview && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Preview:
              </span>
              <p className="text-[11px] text-foreground/70 leading-relaxed line-clamp-3 font-mono whitespace-pre-wrap">
                {contentPreview}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
