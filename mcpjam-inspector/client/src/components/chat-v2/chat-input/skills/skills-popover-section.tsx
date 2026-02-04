import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/chat-utils";
import { SquareSlash, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { listSkills, getSkill } from "@/lib/apis/mcp-skills-api";
import type { SkillListItem, SkillResult } from "./skill-types";
import posthog from "posthog-js";

interface SkillsPopoverSectionProps {
  onSkillSelected: (skillResult: SkillResult) => void;
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  startIndex: number; // Index offset for highlighting (after prompts)
  isHovering: boolean;
  actionTrigger: string | null;
  onOpenUploadDialog?: () => void;
}

export function SkillsPopoverSection({
  onSkillSelected,
  highlightedIndex,
  setHighlightedIndex,
  startIndex,
  isHovering,
  actionTrigger,
  onOpenUploadDialog,
}: SkillsPopoverSectionProps) {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loadingSkillName, setLoadingSkillName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Fetch skills on mount
    let active = true;
    (async () => {
      try {
        setIsLoading(true);
        const skillsList = await listSkills();
        if (!active) return;
        setSkills(skillsList);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[SkillsPopoverSection] Failed to fetch skills", message);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSkillClick = useCallback(
    async (skill: SkillListItem) => {
      try {
        setLoadingSkillName(skill.name);
        const fullSkill = await getSkill(skill.name);
        posthog.capture("skill_injected", { skill_name: skill.name });
        onSkillSelected(fullSkill);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[SkillsPopoverSection] Failed to get skill", message);
      } finally {
        setLoadingSkillName(null);
      }
    },
    [onSkillSelected],
  );

  // Handle Enter key on highlighted skill
  useEffect(() => {
    if (actionTrigger === "Enter") {
      const localIndex = highlightedIndex - startIndex;
      if (localIndex >= 0 && localIndex < skills.length) {
        handleSkillClick(skills[localIndex]);
      }
    }
  }, [actionTrigger, highlightedIndex, startIndex, skills, handleSkillClick]);

  // Don't render anything if still loading or no skills
  if (isLoading) {
    return (
      <div className="px-2 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Loading skills...
        </div>
      </div>
    );
  }

  if (skills.length === 0 && !onOpenUploadDialog) {
    return null;
  }

  return (
    <div>
      {/* Section header */}
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-t border-border mt-1 pt-2">
        <span>SKILLS</span>
      </div>

      {/* Skills list */}
      <div className="flex flex-col">
        {skills.map((skill, index) => {
          const globalIndex = startIndex + index;
          const isHighlighted = highlightedIndex === globalIndex;
          const isLoadingThis = loadingSkillName === skill.name;

          return (
            <Tooltip key={skill.name} delayDuration={1000}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 max-w-[300px] py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground",
                    isHighlighted ? "bg-accent text-accent-foreground" : "",
                  )}
                  onClick={() => handleSkillClick(skill)}
                  onMouseEnter={() => {
                    if (isHovering) {
                      setHighlightedIndex(globalIndex);
                    }
                  }}
                >
                  <SquareSlash size={16} className="shrink-0 text-primary" />
                  <span className="flex-1 text-left truncate">
                    {skill.name}
                  </span>
                  {isLoadingThis && (
                    <Loader2
                      size={14}
                      className="text-muted-foreground shrink-0 ml-2 animate-spin"
                      aria-label="Loading"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{skill.description}</TooltipContent>
            </Tooltip>
          );
        })}

        {/* Empty state with upload button */}
        {skills.length === 0 && onOpenUploadDialog && (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No skills found. Create your first skill!
          </div>
        )}
      </div>
    </div>
  );
}

// Export the skill count getter for the parent popover to calculate navigation
export function useSkillsCount(): { count: number; isLoading: boolean } {
  const [count, setCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const skills = await listSkills();
        if (!active) return;
        setCount(skills.length);
      } catch {
        // Ignore errors, just set count to 0
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return { count, isLoading };
}
