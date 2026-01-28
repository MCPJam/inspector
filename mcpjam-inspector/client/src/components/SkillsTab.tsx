import { useEffect, useState, useCallback } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import {
  SquareSlash,
  RefreshCw,
  Plus,
  Trash2,
  Copy,
  Check,
  Code,
  Eye,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import {
  listSkills,
  getSkill,
  deleteSkill,
  listSkillFiles,
  readSkillFile,
} from "@/lib/apis/mcp-skills-api";
import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "@shared/skill-types";
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
import { SkillsFileTree } from "./skills/SkillsFileTree";
import { SkillFileViewer } from "./skills/SkillFileViewer";

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

  // File browsing state - now stores files per skill
  const [skillFiles, setSkillFiles] = useState<Record<string, SkillFile[]>>({});
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({});
  const [selectedFilePath, setSelectedFilePath] = useState<string>("SKILL.md");
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [fileError, setFileError] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const handleCopy = async () => {
    if (!fileContent?.content) return;
    try {
      await navigator.clipboard.writeText(fileContent.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  useEffect(() => {
    if (selectedSkillName) {
      fetchSkillContent(selectedSkillName);
    } else {
      setSelectedSkill(null);
      setSelectedFilePath("SKILL.md");
      setFileContent(null);
    }
  }, [selectedSkillName]);

  // Load file content when file selection changes
  useEffect(() => {
    if (selectedSkillName && selectedFilePath) {
      fetchFileContent(selectedSkillName, selectedFilePath);
    }
  }, [selectedSkillName, selectedFilePath]);

  const fetchSkills = async () => {
    setFetchingSkills(true);
    setError("");

    try {
      const skillsList = await listSkills();
      setSkills(skillsList);

      if (skillsList.length === 0) {
        setSelectedSkillName("");
        setSelectedSkill(null);
      } else if (
        !skillsList.some(
          (skill: SkillListItem) => skill.name === selectedSkillName,
        )
      ) {
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

  const fetchSkillFilesForSkill = useCallback(
    async (name: string) => {
      // Don't refetch if we already have files for this skill
      if (skillFiles[name] && skillFiles[name].length > 0) {
        return;
      }

      setLoadingFiles((prev) => ({ ...prev, [name]: true }));
      try {
        const files = await listSkillFiles(name);
        setSkillFiles((prev) => ({ ...prev, [name]: files }));
      } catch (err) {
        console.error("Error fetching skill files:", err);
        setSkillFiles((prev) => ({ ...prev, [name]: [] }));
      } finally {
        setLoadingFiles((prev) => ({ ...prev, [name]: false }));
      }
    },
    [skillFiles],
  );

  const fetchFileContent = async (name: string, filePath: string) => {
    setLoadingFileContent(true);
    setFileError("");

    try {
      const content = await readSkillFile(name, filePath);
      setFileContent(content);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Error reading file: ${err}`;
      setFileError(message);
      setFileContent(null);
    } finally {
      setLoadingFileContent(false);
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
      // Remove files from cache
      setSkillFiles((prev) => {
        const next = { ...prev };
        delete next[skillToDelete];
        return next;
      });
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

  const handleSelectSkill = (name: string) => {
    setSelectedSkillName(name);
    setSelectedFilePath("SKILL.md");
    setFileContent(null);
    setRawMode(false);
    setDescriptionExpanded(false);
  };

  const handleSelectFile = (skillName: string, filePath: string) => {
    if (skillName !== selectedSkillName) {
      setSelectedSkillName(skillName);
    }
    setSelectedFilePath(filePath);
    setRawMode(false);
  };

  const handleExpandSkill = (name: string) => {
    fetchSkillFilesForSkill(name);
  };

  const handleLinkClick = (path: string) => {
    setSelectedFilePath(path);
    setRawMode(false);
  };

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left Panel - Unified Skills & Files Tree */}
        <ResizablePanel defaultSize={25} minSize={15} maxSize={40}>
          <div className="h-full flex flex-col border-r border-border bg-background">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-border bg-background">
              <div className="flex items-center gap-3">
                <SquareSlash className="h-3 w-3 text-muted-foreground" />
                <h2 className="text-xs font-semibold text-foreground">
                  Skills
                </h2>
                <Badge variant="secondary" className="text-xs font-mono">
                  {skills.length}
                </Badge>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  onClick={() => setIsUploadDialogOpen(true)}
                  variant="ghost"
                  size="sm"
                  title="Upload skill"
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

            {/* Unified Tree */}
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
                        Upload your first skill
                      </Button>
                    </div>
                  ) : (
                    <SkillsFileTree
                      skills={skills}
                      skillFiles={skillFiles}
                      loadingSkills={fetchingSkills}
                      loadingFiles={loadingFiles}
                      selectedSkillName={selectedSkillName}
                      selectedFilePath={selectedFilePath}
                      onSelectSkill={handleSelectSkill}
                      onSelectFile={handleSelectFile}
                      onExpandSkill={handleExpandSkill}
                    />
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel - File Content */}
        <ResizablePanel defaultSize={75} minSize={50}>
          <div className="h-full flex flex-col bg-background">
            {selectedSkillName && selectedSkill ? (
              <>
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border gap-4">
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm text-foreground truncate">
                        {selectedSkill.name}
                      </span>
                      {selectedFilePath === "SKILL.md" ? (
                        <span
                          className="text-xs text-muted-foreground/60 font-mono truncate"
                          title={selectedSkill.path}
                        >
                          {selectedSkill.path}
                        </span>
                      ) : (
                        <>
                          <span className="text-muted-foreground">/</span>
                          <span className="text-sm text-muted-foreground truncate">
                            {selectedFilePath}
                          </span>
                        </>
                      )}
                    </div>
                    {selectedFilePath === "SKILL.md" &&
                      selectedSkill.description && (
                        <p
                          onClick={() =>
                            setDescriptionExpanded(!descriptionExpanded)
                          }
                          className={`text-xs text-muted-foreground cursor-pointer hover:text-muted-foreground/80 ${descriptionExpanded ? "" : "line-clamp-1"}`}
                        >
                          {selectedSkill.description}
                        </p>
                      )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {fileContent?.isText &&
                      fileContent.mimeType.includes("markdown") && (
                        <Button
                          onClick={() => setRawMode(!rawMode)}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title={rawMode ? "Show rendered" : "Show raw"}
                        >
                          {rawMode ? (
                            <Eye className="h-4 w-4" />
                          ) : (
                            <Code className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                    {fileContent?.isText && (
                      <Button
                        onClick={handleCopy}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        title="Copy"
                      >
                        {copied ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      onClick={() => setSkillToDelete(selectedSkill.name)}
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Delete skill"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* File Content Viewer */}
                <div className="flex-1 overflow-hidden">
                  <SkillFileViewer
                    file={fileContent}
                    loading={loadingFileContent}
                    error={fileError}
                    onLinkClick={handleLinkClick}
                    rawMode={rawMode}
                  />
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon={SquareSlash}
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
      <AlertDialog
        open={!!skillToDelete}
        onOpenChange={() => setSkillToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Skill</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the skill "{skillToDelete}"? This
              will remove the skill directory and its SKILL.md file. This action
              cannot be undone.
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
