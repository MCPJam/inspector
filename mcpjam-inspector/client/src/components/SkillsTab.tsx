import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
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
  Globe,
  Pencil,
  Laptop,
} from "lucide-react";
import { track } from "@/lib/analytics";
import { EmptyState } from "./ui/empty-state";
import {
  listSkills,
  getSkill,
  deleteSkill,
  listSkillFiles,
  readSkillFile,
  promoteSkill,
  type SkillsSource,
} from "@/lib/apis/mcp-skills-api";
import { HOSTED_MODE } from "@/lib/config";
import { ViewModeSelector } from "./shared/view-mode-selector";
import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "@/shared/skill-types";
import {
  ServerSkillsSection,
  type ServerSkillsSectionServer,
} from "./skills/ServerSkillsSection";
import type { VerifiedServerSkill } from "@/lib/apis/server-skills-api";
import { buildServerSkillBanner } from "@/shared/server-skill-banner";
import { SkillUploadDialog } from "./chat-v2/chat-input/skills/skill-upload-dialog";
import { SkillEditDialog } from "./skills/SkillEditDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { SkillsFileTree } from "./skills/SkillsFileTree";
import { SkillFileViewer } from "./skills/SkillFileViewer";

interface SkillsTabProps {
  /** Convex project id — required to address the project skill store. */
  projectId?: string;
  /**
   * Connected MCP servers, for the SEP-2640 "From MCP servers" section. Read
   * LIVE per connection (never from a cache), so a disconnected server simply
   * has no catalog rather than a stale one.
   */
  mcpServers?: ServerSkillsSectionServer[];
  /**
   * Whether the project's own (Cloud) skill store is released to this user —
   * the `skills-enabled` PostHog gate.
   *
   * Skills over MCP ships on its own schedule: it is a PROTOCOL capability
   * served by whatever the user connected, gated only by mutual declaration,
   * and its routes carry no product flag. Cloud Skills are an MCPJam feature
   * whose authoring the backend gates separately. So `false` here hides the
   * project store entirely — tree, count, and upload — and leaves the tab
   * showing only what connected servers serve. It does NOT hide the tab.
   *
   * Defaults to true so local mode, which reads a real filesystem and carries
   * no such gate, is unaffected.
   */
  cloudSkillsEnabled?: boolean;
}

export function SkillsTab({
  projectId,
  mcpServers,
  cloudSkillsEnabled = true,
}: SkillsTabProps = {}) {
  // Which store the tab BROWSES. Hosted mode has no local filesystem, so it is
  // always the project store; locally the user can switch.
  //
  // Gated on the project store's own release flag, not on `computers-enabled`.
  // The two were conflated when cloud skills lived on a Computer's filesystem,
  // and that stopped being true when Convex became the source of truth — so a
  // user with Skills released and Computers not had no way to reach their own
  // project skills, while a user with the reverse got a toggle to a store they
  // could not write to.
  //
  // Note this is a BROWSING choice only. It no longer decides what a chat turn
  // can use: a turn merges local files and project skills into one catalog
  // regardless of what this tab is showing.
  const showSourceToggle = !HOSTED_MODE && !!cloudSkillsEnabled && !!projectId;
  const [source, setSource] = useState<"local" | "cloud">(
    HOSTED_MODE ? "cloud" : "local"
  );
  const isCloudMode = HOSTED_MODE || source === "cloud";
  // Cloud skills are a project resource. Without a project id we must NOT fall
  // back to the local FS API — in hosted mode those routes don't exist, so the
  // page would silently list empty "local" skills and uploads/deletes would
  // 404. Treat cloud-without-project as an explicit not-ready state instead.
  const cloudNotReady = isCloudMode && !projectId;
  /**
   * The project store is not on this surface at all.
   *
   * Folds the two reasons together deliberately: whether cloud skills are
   * unaddressable (no project) or unreleased (`skills-enabled` off), the
   * consequence is identical — never call the project-store API, and never
   * offer authoring. Keeping them apart would mean auditing every call site
   * twice for one rule.
   */
  const cloudStoreHidden = isCloudMode && !cloudSkillsEnabled;
  const cloudUnavailable = cloudNotReady || cloudStoreHidden;
  const skillsSource: SkillsSource = useMemo(
    () =>
      isCloudMode && projectId
        ? { kind: "cloud", projectId }
        : { kind: "local" },
    [isCloudMode, projectId]
  );
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [selectedSkillName, setSelectedSkillName] = useState<string>("");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [fetchingSkills, setFetchingSkills] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // File browsing state - now stores files per skill
  /**
   * Bumped by the header's refresh control.
   *
   * The server-skills rows have no refresh of their own — they sit in the list
   * without a group header to hang one on — so the tab's single control has to
   * reach both halves. It is a counter rather than a callback because the
   * section owns its own per-connection fetch state.
   */
  const [refreshToken, setRefreshToken] = useState(0);
  /**
   * What the server-skills half of the list currently holds.
   *
   * The tab makes two claims about the list as a whole — the header count, and
   * the "no skills yet" call to action — and since the group headers went away
   * both halves are one flat list. Reported up rather than re-derived here: the
   * section owns the per-connection fetch, and only it knows which servers
   * declared the extension at all.
   */
  const [serverSkills, setServerSkills] = useState<{
    count: number;
    pending: boolean;
  }>({ count: 0, pending: false });
  const handleServerSkillsChange = useCallback(
    (state: { count: number; pending: boolean }) => setServerSkills(state),
    []
  );
  const [skillFiles, setSkillFiles] = useState<Record<string, SkillFile[]>>({});
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({});
  const [selectedFilePath, setSelectedFilePath] = useState<string>("SKILL.md");
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  /**
   * Set while the viewer is showing a SERVER skill (SEP-2640).
   *
   * The two name-keyed effects below fetch from the project store by NAME, and
   * a server skill's identity is a URI. Without this marker, opening one would
   * immediately trigger `getSkill(name)` / `readSkillFile(name, …)`, which
   * replaces the verified content (banner and all) with a same-named project
   * skill — or clears it on a read error.
   */
  const [serverSkillUri, setServerSkillUri] = useState<string | null>(null);
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

  // Refetch whenever the data source switches (Local⇄Cloud), clearing the
  // per-skill file cache so stale entries from the other source never bleed
  // across. `resetSelection` forces fetchSkills to pick a fresh selection from
  // the new list rather than honoring the (now-stale) prior selection — a same-
  // named skill in both sources would otherwise leave the tab with nothing
  // selected.
  useEffect(() => {
    setSelectedSkill(null);
    setSkillFiles({});
    fetchSkills({ resetSelection: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsSource]);

  useEffect(() => {
    // A server skill is addressed by URI, and this store is name-keyed — see
    // `serverSkillUri`.
    if (serverSkillUri) return;
    if (selectedSkillName) {
      fetchSkillContent(selectedSkillName);
    } else {
      setSelectedSkill(null);
      setSelectedFilePath("SKILL.md");
      setFileContent(null);
    }
  }, [selectedSkillName, serverSkillUri]);

  // Load file content when file selection changes
  useEffect(() => {
    if (serverSkillUri) return;
    if (selectedSkillName && selectedFilePath) {
      fetchFileContent(selectedSkillName, selectedFilePath);
    }
  }, [selectedSkillName, selectedFilePath, serverSkillUri]);

  const fetchSkills = async (opts?: { resetSelection?: boolean }) => {
    // Any refresh of the PROJECT store re-decides the selection below, and it
    // decides it by name against that store. Leaving the server marker set
    // would strand the pane: the name-keyed content effect stands down, so the
    // viewer would keep showing the server's SKILL.md under whichever project
    // skill the refresh selected.
    //
    // The displayed skill is torn down IN THE SAME TICK as the marker, not
    // left for the fetch below to replace. Clearing the marker alone re-enables
    // the Delete button while `selectedSkill` still holds the SERVER skill —
    // and Delete addresses the project store by name, so a click in that window
    // deletes a same-named project skill from a view showing server content.
    // That is the bug the marker exists to prevent, reachable through its own
    // cleanup. Scoped to the server case so an ordinary project refresh does
    // not blank the pane.
    // The name is left alone: with `selectedSkill` null the pane renders its
    // empty state (and the Delete button is inside that block, so it cannot be
    // clicked), while clearing the marker lets the name-keyed effect re-fetch
    // the PROJECT skill of that name if one exists.
    if (serverSkillUri) {
      setServerSkillUri(null);
      setSelectedSkill(null);
      setFileContent(null);
    }
    // Never call the skills API in cloud mode without a project, or when the
    // project store is unreleased — see `cloudUnavailable`. Show an empty,
    // explicit state rather than a local fallback.
    if (cloudUnavailable) {
      setSkills([]);
      setSelectedSkillName("");
      setSelectedSkill(null);
      setFetchingSkills(false);
      return;
    }
    setFetchingSkills(true);

    try {
      const skillsList = await listSkills(skillsSource);
      setSkills(skillsList);

      // On a source switch the prior selection is stale, so ignore it and pick
      // the first skill. On a plain refresh, keep the current selection if it
      // still exists.
      const currentName = opts?.resetSelection ? "" : selectedSkillName;
      if (skillsList.length === 0) {
        setSelectedSkillName("");
        setSelectedSkill(null);
      } else if (
        !currentName ||
        !skillsList.some((skill: SkillListItem) => skill.name === currentName)
      ) {
        setSelectedSkillName(skillsList[0].name);
      }
    } catch (err) {
      console.error("Could not fetch skills:", err);
    } finally {
      setFetchingSkills(false);
    }
  };

  const fetchSkillContent = async (name: string) => {
    try {
      const skill = await getSkill(name, skillsSource);
      setSelectedSkill(skill);
    } catch (err) {
      console.error("Error getting skill:", err);
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
        const files = await listSkillFiles(name, skillsSource);
        setSkillFiles((prev) => ({ ...prev, [name]: files }));
      } catch (err) {
        console.error("Error fetching skill files:", err);
        setSkillFiles((prev) => ({ ...prev, [name]: [] }));
      } finally {
        setLoadingFiles((prev) => ({ ...prev, [name]: false }));
      }
    },
    [skillFiles, skillsSource]
  );

  const fetchFileContent = async (name: string, filePath: string) => {
    setLoadingFileContent(true);
    setFileError("");

    try {
      const content = await readSkillFile(name, filePath, skillsSource);
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
      await deleteSkill(skillToDelete, skillsSource);
      track("skill_deleted", {
        location: "skills_tab",
        skill_name: skillToDelete,
      });
      // Refresh skills list
      await fetchSkills();
      // Clear selection if deleted skill was selected
      if (selectedSkillName === skillToDelete) {
        setServerSkillUri(null);
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
      console.error("Error deleting skill:", err);
    } finally {
      setIsDeleting(false);
      setSkillToDelete(null);
    }
  };

  const handleSkillCreated = () => {
    fetchSkills();
    setIsUploadDialogOpen(false);
  };

  // The list item for the selected skill carries cloud metadata (sharing/origin)
  // that the detail `Skill` doesn't.
  //
  // Resolved ONLY for project skills. While a server skill is displayed the
  // name is not a project-store key — a server is free to serve a skill called
  // `refunds` while the project also has one, and looking it up by name would
  // attach that project skill's origin badge, its Edit button and its Promote
  // button to third-party content.
  const selectedItem = serverSkillUri
    ? undefined
    : skills.find((s) => s.name === selectedSkillName);

  const handlePromote = async () => {
    if (!projectId || !selectedItem) return;
    try {
      await promoteSkill(selectedItem.name, projectId);
      track("skill_promoted", {
        location: "skills_tab",
        skill_name: selectedItem.name,
      });
      await fetchSkills();
    } catch (err) {
      console.error("Error promoting skill:", err);
    }
  };

  const handleSelectSkill = (name: string) => {
    // Back to the project store — clear the server-origin marker so the
    // name-keyed effects resume.
    setServerSkillUri(null);
    setSelectedSkillName(name);
    setSelectedFilePath("SKILL.md");
    setRawMode(false);
    setDescriptionExpanded(false);
    track("skill_viewed", {
      location: "skills_tab",
      skill_name: name,
    });
    fetchFileContent(name, "SKILL.md");
  };

  /**
   * Shows a LOADED server skill (SEP-2640) in the right-hand viewer.
   *
   * The body is prefixed with an origin banner rather than rendered bare. The
   * two claims are kept apart deliberately: the digest match proves the bytes
   * agree with what the server advertised — CONSISTENCY, not trustworthiness —
   * and the content is third-party input. Showing it without that framing
   * would let a hostile server's SKILL.md read like MCPJam's own copy.
   *
   * Built by the SHARED builder, for two reasons. It collapses whitespace in
   * the server-supplied identity fields, so the frame cannot be broken from
   * inside — this used to be a hand-rolled HTML comment interpolating
   * `skillUri` raw, and a URI containing `-->` closed the comment early and let
   * the rest render as ordinary markdown. And an HTML comment is INVISIBLE in
   * rendered mode, which is the mode this viewer opens in: the framing was
   * hidden exactly where it was supposed to be doing its work.
   */
  const handleOpenServerSkill = useCallback(
    (skill: VerifiedServerSkill, serverLabel: string) => {
      // The bare skill name, not a `<slug>/<name>` ref: refs are namespaced
      // against the turn's server set, which this tab does not have and must
      // not guess — showing a ref that `loadSkill` would resolve elsewhere is
      // worse than showing none.
      const banner = buildServerSkillBanner({
        ref: skill.name,
        serverLabel,
        skillUri: skill.skillUri,
      });
      // Set BEFORE the name, so the name-keyed effects see the marker on the
      // very render that would otherwise fire them.
      setServerSkillUri(skill.skillUri);
      setSelectedSkillName(skill.name);
      setSelectedFilePath("SKILL.md");
      setRawMode(false);
      setDescriptionExpanded(false);
      setFileError("");
      setSelectedSkill({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        path: skill.skillUri,
      });
      setFileContent({
        path: "SKILL.md",
        name: skill.name,
        content: banner + skill.content,
        mimeType: "text/markdown",
        size: skill.content.length,
        isText: true,
      });
      track("skill_viewed", {
        location: "skills_tab",
        skill_name: skill.name,
        skill_origin: "mcp-server",
      });
    },
    []
  );

  const handleSelectFile = (skillName: string, filePath: string) => {
    setServerSkillUri(null);
    if (skillName !== selectedSkillName) {
      setSelectedSkillName(skillName);
    }
    setSelectedFilePath(filePath);
    setRawMode(false);
    fetchFileContent(skillName, filePath);
  };

  const handleExpandSkill = (name: string) => {
    fetchSkillFilesForSkill(name);
  };

  const handleLinkClick = (path: string) => {
    // Ignored while a server skill is displayed. The file-content effect stands
    // down for server skills, so changing the path here would relabel the
    // viewer without changing what it shows — the SKILL.md body would sit under
    // another file's name. Server supporting files are read through the
    // manifest-checked path, which this viewer does not drive.
    if (serverSkillUri) return;
    setSelectedFilePath(path);
    setRawMode(false);
  };

  // Both halves, because the placeholders below speak for the whole list.
  // `listIsSettling` covers a listing that has not answered yet — offering
  // "upload your first skill" in that window would be a claim about a store we
  // are still reading, and it would flash away the moment the rows land.
  const listIsEmpty = skills.length === 0 && serverSkills.count === 0;
  const listIsSettling = fetchingSkills || serverSkills.pending;

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
                {/* Counts BOTH halves, because it counts what is on the screen.
                    It used to count the project store alone, which was
                    unambiguous while server skills sat under a heading of their
                    own and became a plain falsehood when they joined the same
                    flat list — "Skills 0" over a panel of visible rows. The two
                    halves really are different namespaces (a name here, a URI
                    there), but a badge next to a list is read as the length of
                    that list, not as the size of a namespace. */}
                <Badge variant="secondary" className="text-xs font-mono">
                  {skills.length + serverSkills.count}
                </Badge>
              </div>
              {/* Upload and the Local/Cloud toggle act on the project store,
                  so they go with it. Refresh does NOT: it re-reads the server
                  skills too, and those are exactly what is on screen when the
                  project store is hidden. */}
              <div className="flex items-center gap-1">
                {!cloudStoreHidden && (
                  <>
                    {showSourceToggle && (
                      <ViewModeSelector
                        value={source}
                        ariaLabel="Skills source"
                        indicatorId="skills-source"
                        onChange={(next) => setSource(next)}
                        options={[
                          { value: "local", label: "Local" },
                          { value: "cloud", label: "Cloud" },
                        ]}
                        className="mr-1"
                      />
                    )}
                    <Button
                      onClick={() => setIsUploadDialogOpen(true)}
                      variant="ghost"
                      size="sm"
                      title="Upload skill"
                      disabled={cloudUnavailable}
                    >
                      <Plus className="h-3 w-3 cursor-pointer" />
                    </Button>
                  </>
                )}
                <Button
                  onClick={() => {
                    void fetchSkills();
                    setRefreshToken((n) => n + 1);
                  }}
                  variant="ghost"
                  size="sm"
                  title="Refresh skills"
                  disabled={fetchingSkills}
                >
                  <RefreshCw
                    className={`h-3 w-3 ${
                      fetchingSkills ? "animate-spin" : ""
                    } cursor-pointer`}
                  />
                </Button>
              </div>
            </div>

            {/* Unified Tree */}
            <div className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2">
                  {!cloudStoreHidden && skills.length > 0 && (
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
                  {/* Skills over MCP (SEP-2640). Rendered outside the tree —
                      these are identified by URI rather than by name and carry
                      a verification state the tree has no vocabulary for — but
                      NOT under a heading of their own: each row carries its
                      origin server instead, so provenance travels with the
                      skill rather than with the reader's scroll position. */}
                  <ServerSkillsSection
                    servers={mcpServers ?? []}
                    {...(projectId ? { projectId } : {})}
                    refreshToken={refreshToken}
                    onOpenSkill={handleOpenServerSkill}
                    onListingChange={handleServerSkillsChange}
                  />
                  {/* Placeholders for the WHOLE list, so they render only when
                      the whole list is empty — and BELOW the rows, so nothing
                      can sit above them. The project store's own empty state
                      used to render on its own count: a signed-out user with a
                      server serving skills got a hundred-odd pixels of centered
                      "upload your first skill" wedged between the header and
                      rows that were right there. */}
                  {listIsEmpty &&
                    !cloudStoreHidden &&
                    (listIsSettling ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                          <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
                        </div>
                        <p className="text-xs text-muted-foreground font-semibold mb-1">
                          Loading skills...
                        </p>
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <p className="text-sm text-muted-foreground mb-4">
                          No skills available
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setIsUploadDialogOpen(true)}
                          disabled={cloudUnavailable}
                        >
                          <Plus className="h-3 w-3 mr-2" />
                          Upload your first skill
                        </Button>
                      </div>
                    ))}
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
                      {selectedItem && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] uppercase tracking-wide flex-shrink-0"
                        >
                          {selectedItem.origin === "cloud"
                            ? selectedItem.sharing === "project"
                              ? "Shared"
                              : "Personal"
                            : "Local"}
                        </Badge>
                      )}
                      {/* `selectedItem` is deliberately undefined for a server
                          skill, so it gets its own badge — a header with no
                          origin at all would read as a local skill. */}
                      {serverSkillUri && (
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase tracking-wide flex-shrink-0"
                          title="Served by a connected MCP server. Content is untrusted third-party input."
                        >
                          MCP server
                        </Badge>
                      )}
                      {selectedItem?.provenance === "computer-adopted" && (
                        <Badge
                          variant="outline"
                          className="text-[10px] tracking-wide flex-shrink-0 gap-1 border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                          title="Synced up from a skill installed on your Computer"
                        >
                          <Laptop className="h-3 w-3" />
                          From your computer
                        </Badge>
                      )}
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
                          className={`text-xs text-muted-foreground cursor-pointer hover:text-muted-foreground/80 ${
                            descriptionExpanded ? "" : "line-clamp-1"
                          }`}
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
                    {selectedItem?.origin === "cloud" &&
                      selectedFilePath === "SKILL.md" && (
                        <Button
                          onClick={() => setIsEditDialogOpen(true)}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="Edit skill"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    {selectedItem?.origin === "cloud" &&
                      selectedItem.sharing === "user" && (
                        <Button
                          onClick={handlePromote}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="Promote to project (share with all members)"
                        >
                          <Globe className="h-4 w-4" />
                        </Button>
                      )}
                    {/* Not offered for a server skill. `deleteSkill` addresses
                        the PROJECT store by name, so on a name collision this
                        would delete the user's own skill while they were
                        looking at a server's — data loss with no visible
                        relation to the click. MCPJam does not own server
                        content and cannot delete it. */}
                    {!serverSkillUri && (
                      <Button
                        onClick={() => setSkillToDelete(selectedSkill.name)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete skill"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
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
        source={skillsSource}
      />

      {/* Edit Dialog (cloud skills only) */}
      <SkillEditDialog
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        skill={selectedSkill}
        skillId={selectedItem?.skillId}
        source={skillsSource}
        onSaved={async (updated) => {
          setSelectedSkill(updated);
          await fetchSkills();
          if (selectedSkillName) {
            await fetchFileContent(selectedSkillName, "SKILL.md");
          }
        }}
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
