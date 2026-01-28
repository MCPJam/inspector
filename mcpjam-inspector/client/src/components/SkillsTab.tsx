import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { Sparkles, RefreshCw, ChevronRight, Plus, Trash2 } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import {
  listSkills,
  getSkill,
  deleteSkill,
} from "@/lib/apis/mcp-skills-api";
import type { Skill, SkillListItem } from "@shared/skill-types";
import { SkillUploadDialog } from "./chat-v2/chat-input/skills/skill-upload-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { MemoizedMarkdown } from "./chat-v2/thread/memomized-markdown";

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [selectedSkillName, setSelectedSkillName] = useState<string>("");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingSkills, setFetchingSkills] = useState(false);
  const [error, setError] = useState<string>("");
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    fetchSkills();
  }, []);

  useEffect(() => {
    if (selectedSkillName) {
      fetchSkillContent(selectedSkillName);
    } else {
      setSelectedSkill(null);
    }
  }, [selectedSkillName]);

  const fetchSkills = async () => {
    setFetchingSkills(true);
    setError("");

    try {
      const skillsList = await listSkills();
      setSkills(skillsList);

      if (skillsList.length === 0) {
        setSelectedSkillName("");
        setSelectedSkill(null);
      } else if (!skillsList.some((skill) => skill.name === selectedSkillName)) {
        setSelectedSkillName(skillsList[0].name);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Could not fetch skills: ${err}`;
      setError(message);
    } finally {
      setFetchingSkills(false);
    }
  };

  const fetchSkillContent = async (name: string) => {
    setLoading(true);
    setError("");

    try {
      const skill = await getSkill(name);
      setSelectedSkill(skill);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Error getting skill: ${err}`;
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSkill = async () => {
    if (!skillToDelete) return;

    setIsDeleting(true);
    try {
      await deleteSkill(skillToDelete);
      // Refresh skills list
      await fetchSkills();
      // Clear selection if deleted skill was selected
      if (selectedSkillName === skillToDelete) {
        setSelectedSkillName("");
        setSelectedSkill(null);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Error deleting skill: ${err}`;
      setError(message);
    } finally {
      setIsDeleting(false);
      setSkillToDelete(null);
    }
  };

  const handleSkillCreated = () => {
    fetchSkills();
    setIsUploadDialogOpen(false);
  };

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left Panel - Skills List */}
        <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
          <div className="h-full flex flex-col border-r border-border bg-background">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-border bg-background">
              <div className="flex items-center gap-3">
                <Sparkles className="h-3 w-3 text-muted-foreground" />
                <h2 className="text-xs font-semibold text-foreground">Skills</h2>
                <Badge variant="secondary" className="text-xs font-mono">
                  {skills.length}
                </Badge>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  onClick={() => setIsUploadDialogOpen(true)}
                  variant="ghost"
                  size="sm"
                  title="Create new skill"
                >
                  <Plus className="h-3 w-3 cursor-pointer" />
                </Button>
                <Button
                  onClick={fetchSkills}
                  variant="ghost"
                  size="sm"
                  disabled={fetchingSkills}
                >
                  <RefreshCw
                    className={`h-3 w-3 ${fetchingSkills ? "animate-spin" : ""} cursor-pointer`}
                  />
                </Button>
              </div>
            </div>

            {/* Skills List */}
            <div className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2">
                  {fetchingSkills ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                        <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
                      </div>
                      <p className="text-xs text-muted-foreground font-semibold mb-1">
                        Loading skills...
                      </p>
                      <p className="text-xs text-muted-foreground/70">
                        Fetching available skills from .mcpjam/skills
                      </p>
                    </div>
                  ) : skills.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-sm text-muted-foreground mb-4">
                        No skills available
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsUploadDialogOpen(true)}
                      >
                        <Plus className="h-3 w-3 mr-2" />
                        Create your first skill
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {skills.map((skill) => {
                        const isSelected = selectedSkillName === skill.name;
                        return (
                          <div
                            key={skill.name}
                            className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                              isSelected
                                ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                                : "hover:shadow-sm"
                            }`}
                            onClick={() => setSelectedSkillName(skill.name)}
                          >
                            <div className="flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                                    {skill.name}
                                  </code>
                                </div>
                                {skill.description && (
                                  <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
                                    {skill.description}
                                  </p>
                                )}
                              </div>
                              <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel - Skill Content */}
        <ResizablePanel defaultSize={70} minSize={50}>
          <div className="h-full flex flex-col bg-background">
            {selectedSkillName && selectedSkill ? (
              <>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                        {selectedSkill.name}
                      </code>
                    </div>
                  </div>
                  <Button
                    onClick={() => setSkillToDelete(selectedSkill.name)}
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </Button>
                </div>

                {/* Description */}
                {selectedSkill.description && (
                  <div className="px-6 py-4 bg-muted/50 border-b border-border">
                    <p className="text-xs text-muted-foreground leading-relaxed font-medium">
                      {selectedSkill.description}
                    </p>
                  </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="px-6 py-6">
                      {loading ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                            <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
                          </div>
                          <p className="text-xs text-muted-foreground font-semibold">
                            Loading skill content...
                          </p>
                        </div>
                      ) : error ? (
                        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                          {error}
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div>
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                              Skill Content
                            </h3>
                            <div className="prose prose-sm dark:prose-invert max-w-none bg-muted/30 p-4 rounded-md border border-border">
                              <MemoizedMarkdown content={selectedSkill.content} />
                            </div>
                          </div>
                          <div>
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                              Path
                            </h3>
                            <code className="text-xs font-mono bg-muted px-2 py-1 rounded border border-border">
                              {selectedSkill.path}/SKILL.md
                            </code>
                          </div>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon={Sparkles}
                  title="Select a Skill"
                  description="Choose a skill from the left to view its content, or create a new one."
                />
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Upload Dialog */}
      <SkillUploadDialog
        open={isUploadDialogOpen}
        onOpenChange={setIsUploadDialogOpen}
        onSkillCreated={handleSkillCreated}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!skillToDelete} onOpenChange={() => setSkillToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Skill</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the skill "{skillToDelete}"? This will
              remove the skill directory and its SKILL.md file. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSkill}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
