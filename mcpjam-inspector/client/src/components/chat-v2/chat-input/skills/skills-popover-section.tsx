import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/chat-utils";
import { SquareSlash, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import {
  listSkills,
  getSkill,
  type SkillsSource,
} from "@/lib/apis/mcp-skills-api";
import type { SkillListItem, SkillResult } from "./skill-types";
import {
  getServerSkill,
  listServerSkills,
  type ServerSkillSummary,
} from "@/lib/apis/server-skills-api";
import { buildServerSkillToolOutput } from "../../../../../../shared/server-skill-banner";
import { track } from "@/lib/analytics";

interface SkillsPopoverSectionProps {
  onSkillSelected: (skillResult: SkillResult) => void;
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  startIndex: number; // Index offset for highlighting (after prompts)
  isHovering: boolean;
  actionTrigger: string | null;
  onOpenUploadDialog?: () => void;
  /** When set, list/load skills from the cloud (Convex/Computer) source. */
  skillsSource?: SkillsSource;
  /**
   * Connected MCP servers whose skills (SEP-2640) may be injected. Read live
   * per connection, so a disconnected server contributes nothing rather than a
   * stale catalog.
   */
  mcpServers?: Array<{ serverId: string; label: string; connected: boolean }>;
  /** Convex project id — required for the hosted server-skills route. */
  projectId?: string;
}

/** One server skill in the picker, plus the provider it came from. */
interface ServerSkillPickerItem extends ServerSkillSummary {
  serverLabel: string;
  /** `<serverSlug>/<name>` — the same address the chat wrapper uses. */
  ref: string;
}

/** Slugifies a server LABEL for the ref namespace. Mirrors the server rule. */
function slugifyServerLabel(label: string): string {
  const slug = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "server";
}

export function SkillsPopoverSection({
  onSkillSelected,
  highlightedIndex,
  setHighlightedIndex,
  startIndex,
  isHovering,
  actionTrigger,
  onOpenUploadDialog,
  skillsSource,
  mcpServers,
  projectId,
}: SkillsPopoverSectionProps) {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [serverSkills, setServerSkills] = useState<ServerSkillPickerItem[]>([]);
  const [loadingSkillName, setLoadingSkillName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Fetch skills on mount
    let active = true;
    (async () => {
      try {
        setIsLoading(true);
        const skillsList = await listSkills(skillsSource);
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
  }, [skillsSource]);

  // Server-served skills (SEP-2640). Fetched per connected server, and only
  // for connections where the extension is mutually declared — the API answers
  // with `support.active: false` and an empty list otherwise, so a
  // non-declaring server simply contributes nothing.
  useEffect(() => {
    let active = true;
    const connected = (mcpServers ?? []).filter((server) => server.connected);
    if (connected.length === 0) {
      setServerSkills([]);
      return;
    }
    (async () => {
      const collected: ServerSkillPickerItem[] = [];
      const taken = new Set<string>();
      for (const server of connected) {
        let slug = slugifyServerLabel(server.label);
        let suffix = 2;
        while (taken.has(slug)) {
          slug = `${slugifyServerLabel(server.label)}-${suffix}`;
          suffix += 1;
        }
        taken.add(slug);
        try {
          const listing = await listServerSkills({
            serverId: server.serverId,
            ...(projectId ? { projectId } : {}),
          });
          for (const skill of listing.skills) {
            collected.push({
              ...skill,
              serverLabel: server.label,
              ref: `${slug}/${skill.name}`,
            });
          }
        } catch {
          // One unreachable server must not remove another's skills from the
          // picker, and a failed listing is not worth a UI error here.
        }
      }
      if (active) setServerSkills(collected);
    })();
    return () => {
      active = false;
    };
  }, [mcpServers, projectId]);

  /**
   * Injects a server skill as a synthetic `loadSkill` result.
   *
   * The content is loaded through the SAME verified path the chat tool uses,
   * and wrapped in the SAME shared banner — a popover click must produce a
   * message the tool could genuinely have returned. A skill that fails a
   * mandatory check is not injected at all: silently injecting unverified
   * content would defeat every check upstream of it.
   */
  const handleServerSkillClick = useCallback(
    async (item: ServerSkillPickerItem) => {
      if (item.unloadable) return;
      try {
        setLoadingSkillName(item.ref);
        const result = await getServerSkill({
          serverId: item.serverId,
          uri: item.skillUri,
          ...(projectId ? { projectId } : {}),
        });
        if (!result.ok) {
          console.error(
            "[SkillsPopoverSection] Server skill refused",
            result.refusal,
          );
          return;
        }
        track("skill_injected", {
          location: "chat_input_skills_popover",
          skill_name: item.ref,
          skill_origin: "mcp-server",
        });
        onSkillSelected({
          name: item.ref,
          description: result.skill.description,
          content: result.skill.content,
          path: result.skill.skillUri,
          toolOutput: buildServerSkillToolOutput({
            ref: item.ref,
            serverLabel: item.serverLabel,
            skillUri: result.skill.skillUri,
            content: result.skill.content,
          }),
        });
      } finally {
        setLoadingSkillName(null);
      }
    },
    [onSkillSelected, projectId],
  );

  const handleSkillClick = useCallback(
    async (skill: SkillListItem) => {
      try {
        setLoadingSkillName(skill.name);
        const fullSkill = await getSkill(skill.name, skillsSource);
        track("skill_injected", {
          location: "chat_input_skills_popover",
          skill_name: skill.name,
        });
        // Stamp the source onto the result so later file reads (expanding the
        // card) stay pinned to the project it was selected from.
        onSkillSelected({ ...fullSkill, source: skillsSource });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[SkillsPopoverSection] Failed to get skill", message);
      } finally {
        setLoadingSkillName(null);
      }
    },
    [onSkillSelected, skillsSource],
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

  if (skills.length === 0 && serverSkills.length === 0 && !onOpenUploadDialog) {
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

        {/* Server-served skills (SEP-2640), grouped under their own heading.
            Kept visually distinct from project skills because their contents
            come from a third party — the same reason the injected message
            carries an origin banner. */}
        {serverSkills.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              From MCP servers
            </div>
            {serverSkills.map((item) => {
              const isLoadingThis = loadingSkillName === item.ref;
              return (
                <Tooltip key={item.skillUri} delayDuration={1000}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      disabled={Boolean(item.unloadable)}
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 max-w-[300px] py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground",
                        item.unloadable
                          ? "opacity-60 cursor-not-allowed hover:bg-transparent"
                          : "",
                      )}
                      onClick={() => handleServerSkillClick(item)}
                    >
                      <SquareSlash
                        size={16}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="flex-1 text-left truncate">
                        {item.ref}
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
                  <TooltipContent>
                    {item.unloadable
                      ? item.unloadable.message
                      : `${item.description} — served by "${item.serverLabel}"`}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </>
        )}

        {/* Empty state with upload button */}
        {skills.length === 0 && serverSkills.length === 0 && onOpenUploadDialog && (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No skills found. Create your first skill!
          </div>
        )}
      </div>
    </div>
  );
}

// Export the skill count getter for the parent popover to calculate navigation
export function useSkillsCount(skillsSource?: SkillsSource): {
  count: number;
  isLoading: boolean;
} {
  const [count, setCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const skills = await listSkills(skillsSource);
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
  }, [skillsSource]);

  return { count, isLoading };
}
