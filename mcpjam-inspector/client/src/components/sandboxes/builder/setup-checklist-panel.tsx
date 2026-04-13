import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Globe, Loader2, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SandboxShareSection } from "@/components/sandboxes/SandboxShareSection";
import type { SandboxSettings, SandboxMode } from "@/hooks/useSandboxes";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import {
  getSandboxHostLogo,
  getSandboxHostStyleShortLabel,
  type SandboxHostStyle,
} from "@/lib/sandbox-host-style";
import { isMCPJamProvidedModel, SUPPORTED_MODELS } from "@/shared/types";
import { cn } from "@/lib/utils";
import type { SandboxDraftConfig } from "./types";
import { countRequiredServers } from "./sandbox-server-optional";

export type SetupSectionId =
  | "basics"
  | "servers"
  | "access"
  | "welcome"
  | "feedback"
  | "advanced";

type SectionStatusKind =
  | "complete"
  | "attention"
  | "optional"
  | "default_on"
  | "collapsed";

function SectionStatusBadge({ kind }: { kind: SectionStatusKind }) {
  switch (kind) {
    case "complete":
      return (
        <Badge
          variant="outline"
          className="border-emerald-600/55 bg-emerald-500/[0.14] px-3 py-0.5 text-emerald-900 dark:border-emerald-400/45 dark:bg-emerald-950/50 dark:text-emerald-200"
        >
          Complete
        </Badge>
      );
    case "attention":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300"
        >
          Attention
        </Badge>
      );
    case "optional":
      return (
        <Badge variant="secondary" className="font-normal">
          Optional
        </Badge>
      );
    case "default_on":
      return (
        <Badge variant="secondary" className="font-normal">
          Default on
        </Badge>
      );
    case "collapsed":
      return (
        <Badge variant="secondary" className="font-normal">
          Collapsed
        </Badge>
      );
    default:
      return null;
  }
}

function SetupSectionStepIndex({ step }: { step: number }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-xs font-semibold tabular-nums text-muted-foreground transition-colors",
      )}
    >
      {step}
    </span>
  );
}

const setupSectionCollapsibleTriggerClass =
  "group flex w-full items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-3 text-left hover:bg-muted/35";

function SetupSectionCollapsibleTrigger({
  step,
  title,
  statusKind,
}: {
  step: number;
  title: string;
  statusKind: SectionStatusKind;
}) {
  return (
    <CollapsibleTrigger className={setupSectionCollapsibleTriggerClass}>
      <div className="flex min-w-0 items-center gap-2.5">
        <SetupSectionStepIndex step={step} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SectionStatusBadge kind={statusKind} />
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </div>
    </CollapsibleTrigger>
  );
}

function isInsecureUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

function updateSelectedServerIds(
  currentServerIds: string[],
  serverId: string,
  checked: boolean,
): string[] {
  const hasServer = currentServerIds.includes(serverId);
  if (checked) {
    return hasServer ? currentServerIds : [...currentServerIds, serverId];
  }
  return hasServer
    ? currentServerIds.filter((id) => id !== serverId)
    : currentServerIds;
}

/** Shared checklist of workspace HTTP(S) servers; used in Setup and on the canvas + control. */
export function WorkspaceServerPickerList({
  workspaceServers,
  selectedServerIds,
  onToggleSelection,
}: {
  workspaceServers: RemoteServer[];
  selectedServerIds: string[];
  onToggleSelection: (serverId: string, checked: boolean) => void;
}) {
  const availableServers = workspaceServers.filter(
    (server) => server.transportType === "http",
  );
  const selectedServerSet = new Set(selectedServerIds);

  if (availableServers.length === 0) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">
        No HTTP servers in this workspace. Use Add to create one.
      </p>
    );
  }

  return (
    <div className="max-h-56 overflow-y-auto">
      {availableServers.map((server) => {
        const insecure = isInsecureUrl(server.url);
        return (
          <label
            key={server._id}
            className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${insecure ? "cursor-not-allowed opacity-50" : "hover:bg-muted/50"}`}
            title={insecure ? "Sandboxes require HTTPS server URLs" : undefined}
          >
            <Checkbox
              checked={!insecure && selectedServerSet.has(server._id)}
              onCheckedChange={(checked) =>
                onToggleSelection(server._id, checked === true)
              }
              disabled={insecure}
            />
            <span className="flex-1 text-sm">{server.name}</span>
            {insecure ? (
              <span className="text-[10px] text-destructive">
                Requires HTTPS
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

export function ServerSelectionEditor({
  workspaceServers,
  selectedServerIds,
  optionalServerIds,
  onToggleSelection,
  onOptionalChange,
  onOpenAdd,
}: {
  workspaceServers: RemoteServer[];
  selectedServerIds: string[];
  optionalServerIds: string[];
  onToggleSelection: (serverId: string, checked: boolean) => void;
  onOptionalChange: (serverId: string, optional: boolean) => void;
  onOpenAdd: () => void;
}) {
  const availableServers = workspaceServers.filter(
    (server) => server.transportType === "http",
  );
  const selectedServerSet = new Set(selectedServerIds);
  const optionalServerSet = new Set(optionalServerIds);
  const selectedServers = availableServers.filter((server) =>
    selectedServerSet.has(server._id),
  );

  const selectionSummary =
    selectedServers.length === 0
      ? "Choose workspace servers…"
      : selectedServers.length === 1
        ? "1 server selected"
        : `${selectedServers.length} servers selected`;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">MCP servers</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick HTTPS servers from the workspace, then set whether each connects
          at start or only when the tester adds it from chat.
        </p>
      </div>

      <div className="flex min-w-0 gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Select MCP servers. ${selectionSummary}`}
              className="flex min-h-9 min-w-0 flex-1 items-center justify-between rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
            >
              <span
                className={
                  selectedServers.length === 0
                    ? "text-muted-foreground"
                    : "text-foreground"
                }
              >
                {selectionSummary}
              </span>
              <ChevronDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-1"
            align="start"
          >
            <WorkspaceServerPickerList
              workspaceServers={workspaceServers}
              selectedServerIds={selectedServerIds}
              onToggleSelection={onToggleSelection}
            />
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={onOpenAdd}
          aria-label="Add MCP server to workspace"
        >
          <Plus className="size-4" />
          Add server
        </Button>
      </div>

      {selectedServers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Select at least one HTTPS server to continue.
        </p>
      ) : null}

      {selectedServers.length > 0 ? (
        <div className="space-y-3">
          {selectedServers.map((server) => {
            const isOptional = optionalServerSet.has(server._id);
            const requiredCount = countRequiredServers(
              selectedServerIds,
              optionalServerIds,
            );
            const cannotMarkOptional = !isOptional && requiredCount === 1;

            return (
              <Card
                key={server._id}
                className="gap-3 rounded-2xl p-3 py-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium leading-tight">{server.name}</p>
                    <p className="mt-0.5 font-mono text-xs leading-snug text-muted-foreground">
                      {server.url ?? "Workspace server"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge
                        variant="outline"
                        className="text-[11px] font-normal"
                      >
                        {server.useOAuth ? "OAuth" : "Direct"}
                      </Badge>
                      <Badge
                        variant={
                          isInsecureUrl(server.url) ? "secondary" : "outline"
                        }
                        className="text-[11px] font-normal"
                      >
                        {isInsecureUrl(server.url) ? "Requires HTTPS" : "HTTPS"}
                      </Badge>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => onToggleSelection(server._id, false)}
                  >
                    Remove
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <p
                    className="text-xs font-medium leading-snug text-muted-foreground"
                    id={`server-startup-${server._id}`}
                  >
                    Require server to connect at start or allow tester to add
                    later
                  </p>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    value={isOptional ? "optional" : "required"}
                    onValueChange={(value) => {
                      if (value === "optional") {
                        if (cannotMarkOptional) {
                          toast.message(
                            "Add another server before marking this one optional. At least one server must connect when the sandbox opens.",
                          );
                          return;
                        }
                        onOptionalChange(server._id, true);
                        return;
                      }
                      if (value === "required") {
                        onOptionalChange(server._id, false);
                      }
                    }}
                    aria-labelledby={`server-startup-${server._id}`}
                  >
                    <ToggleGroupItem
                      value="required"
                      className="flex-1 px-3 text-xs"
                      aria-label="Required: connect at start"
                    >
                      Required
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="optional"
                      className="flex-1 px-3 text-xs"
                      aria-label="Optional: tester adds later from chat"
                    >
                      Optional
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function computeSectionStatuses(
  draft: SandboxDraftConfig,
  workspaceServers: RemoteServer[],
): Record<SetupSectionId, SectionStatusKind> {
  const nameOk = draft.name.trim().length > 0;
  const modelOk = Boolean(draft.modelId);
  const basics: SectionStatusKind =
    nameOk && modelOk ? "complete" : "attention";

  const optionalServerSet = new Set(draft.optionalServerIds);
  const validServerCount = draft.selectedServerIds.filter((id) => {
    if (optionalServerSet.has(id)) return false;
    const s = workspaceServers.find((w) => w._id === id);
    return s && !isInsecureUrl(s.url);
  }).length;
  const servers: SectionStatusKind =
    validServerCount > 0 ? "complete" : "attention";

  const access: SectionStatusKind = draft.mode ? "complete" : "attention";

  const welcome: SectionStatusKind = draft.welcomeDialog.enabled
    ? "default_on"
    : "optional";

  const feedbackInvalid =
    draft.feedbackDialog.enabled && draft.feedbackDialog.everyNToolCalls < 1;
  const feedback: SectionStatusKind = feedbackInvalid
    ? "attention"
    : draft.feedbackDialog.enabled
      ? "default_on"
      : "optional";

  return {
    basics,
    servers,
    access,
    welcome,
    feedback,
    advanced: "collapsed",
  };
}

export function SetupChecklistPanel({
  sandboxDraft,
  savedSandbox,
  workspaceServers,
  workspaceName,
  focusedSection,
  /** True when creating a sandbox that has never been saved (no sandbox id yet). */
  isUnsavedNewDraft,
  onDraftChange,
  onOpenAddServer,
  onToggleServer,
  onServerOptionalChange,
  onCloseMobile,
  /** When the sandbox is saved, invite someone by email from the Access dialog (invite-only mode). */
  inviteSandboxMember,
}: {
  sandboxDraft: SandboxDraftConfig;
  savedSandbox: SandboxSettings | null;
  workspaceServers: RemoteServer[];
  workspaceName?: string | null;
  focusedSection: SetupSectionId | null;
  isUnsavedNewDraft: boolean;
  onDraftChange: (
    updater: (draft: SandboxDraftConfig) => SandboxDraftConfig,
  ) => void;
  onOpenAddServer: () => void;
  onToggleServer: (serverId: string, checked: boolean) => void;
  onServerOptionalChange: (serverId: string, optional: boolean) => void;
  onCloseMobile?: () => void;
  inviteSandboxMember?: (email: string) => Promise<void>;
}) {
  const statuses = useMemo(
    () => computeSectionStatuses(sandboxDraft, workspaceServers),
    [sandboxDraft, workspaceServers],
  );

  const sectionRefs = useRef<
    Partial<Record<SetupSectionId, HTMLDivElement | null>>
  >({});

  const [openMap, setOpenMap] = useState<
    Partial<Record<SetupSectionId, boolean>>
  >({});
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [accessInviteEmail, setAccessInviteEmail] = useState("");
  const [accessInviteBusy, setAccessInviteBusy] = useState(false);
  const didAutoExpandRef = useRef(false);

  useEffect(() => {
    if (!isUnsavedNewDraft || didAutoExpandRef.current) return;
    const order: SetupSectionId[] = [
      "basics",
      "servers",
      "access",
      "welcome",
      "feedback",
      "advanced",
    ];
    const firstIncomplete = order.find((id) => statuses[id] === "attention");
    if (firstIncomplete) {
      setOpenMap((prev) => ({ ...prev, [firstIncomplete]: true }));
    }
    didAutoExpandRef.current = true;
  }, [isUnsavedNewDraft, statuses]);

  useEffect(() => {
    if (!focusedSection) return;
    setOpenMap((prev) => ({ ...prev, [focusedSection]: true }));
    const el = sectionRefs.current[focusedSection];
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedSection]);

  const hostedModels = useMemo(
    () =>
      SUPPORTED_MODELS.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      ),
    [],
  );

  const setSectionOpen = (id: SetupSectionId, open: boolean) => {
    setOpenMap((prev) => ({ ...prev, [id]: open }));
  };

  const handleAccessInvite = async () => {
    if (!inviteSandboxMember) return;
    const normalized = accessInviteEmail.trim().toLowerCase();
    if (!normalized) return;
    setAccessInviteBusy(true);
    try {
      await inviteSandboxMember(normalized);
      toast.success(`Invited ${normalized}`);
      setAccessInviteEmail("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to send invite",
      );
    } finally {
      setAccessInviteBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {onCloseMobile ? (
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 md:hidden">
          <h3 className="text-base font-semibold">Setup</h3>
          <Button variant="ghost" size="sm" onClick={onCloseMobile}>
            Done
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-4 pb-28">
          {/* Basics */}
          <div
            ref={(el) => {
              sectionRefs.current.basics = el;
            }}
          >
            <Collapsible
              open={openMap.basics ?? false}
              onOpenChange={(o) => setSectionOpen("basics", o)}
            >
              <SetupSectionCollapsibleTrigger
                step={1}
                title="Basics"
                statusKind={statuses.basics}
              />
              <CollapsibleContent className="pt-3 pb-1">
                <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
                  <div className="space-y-2">
                    <Label htmlFor="setup-sandbox-name">Sandbox name</Label>
                    <Input
                      id="setup-sandbox-name"
                      value={sandboxDraft.name}
                      onChange={(event) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          name: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-sandbox-description">
                      Description
                    </Label>
                    <Textarea
                      id="setup-sandbox-description"
                      rows={2}
                      value={sandboxDraft.description}
                      onChange={(event) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          description: event.target.value,
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional — helpful for collaborators, not required for
                      first save.
                    </p>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>Host style</Label>
                    <div className="grid gap-2">
                      {(["claude", "chatgpt"] as SandboxHostStyle[]).map(
                        (hostStyle) => {
                          const selected = sandboxDraft.hostStyle === hostStyle;
                          return (
                            <button
                              key={hostStyle}
                              type="button"
                              className={`flex items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-colors ${
                                selected
                                  ? "border-primary/50 bg-primary/10"
                                  : "border-border/70 bg-card/60 hover:bg-muted/20"
                              }`}
                              onClick={() =>
                                onDraftChange((draft) => ({
                                  ...draft,
                                  hostStyle,
                                }))
                              }
                            >
                              <img
                                src={getSandboxHostLogo(hostStyle)}
                                alt=""
                                className="size-6 rounded-md object-contain"
                              />
                              <div>
                                <p className="font-medium">
                                  {getSandboxHostStyleShortLabel(hostStyle)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Sandbox shell matches this host style.
                                </p>
                              </div>
                            </button>
                          );
                        },
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Model</Label>
                    <Select
                      value={sandboxDraft.modelId}
                      onValueChange={(value) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          modelId: value,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {hostedModels.map((model) => (
                          <SelectItem
                            key={String(model.id)}
                            value={String(model.id)}
                          >
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Servers */}
          <div
            ref={(el) => {
              sectionRefs.current.servers = el;
            }}
          >
            <Collapsible
              open={openMap.servers ?? false}
              onOpenChange={(o) => setSectionOpen("servers", o)}
            >
              <SetupSectionCollapsibleTrigger
                step={2}
                title="Servers"
                statusKind={statuses.servers}
              />
              <CollapsibleContent className="pt-3 pb-1">
                <div className="rounded-xl border border-border/50 bg-card/40 p-4">
                  <ServerSelectionEditor
                    workspaceServers={workspaceServers}
                    selectedServerIds={sandboxDraft.selectedServerIds}
                    optionalServerIds={sandboxDraft.optionalServerIds}
                    onToggleSelection={onToggleServer}
                    onOptionalChange={onServerOptionalChange}
                    onOpenAdd={onOpenAddServer}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Access */}
          <div
            ref={(el) => {
              sectionRefs.current.access = el;
            }}
          >
            <Collapsible
              open={openMap.access ?? false}
              onOpenChange={(o) => setSectionOpen("access", o)}
            >
              <SetupSectionCollapsibleTrigger
                step={3}
                title="Access"
                statusKind={statuses.access}
              />
              <CollapsibleContent className="pt-3 pb-1">
                <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
                  <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/60 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                        {sandboxDraft.mode === "any_signed_in_with_link" ? (
                          <Globe className="size-4 text-muted-foreground" />
                        ) : (
                          <Lock className="size-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {sandboxDraft.mode === "any_signed_in_with_link"
                            ? "Anyone with the link"
                            : "Invited users only"}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {sandboxDraft.mode === "any_signed_in_with_link"
                            ? "Any signed-in user with the link can open this sandbox."
                            : "Only people you invite can access this sandbox."}{" "}
                          Guest access{" "}
                          {sandboxDraft.allowGuestAccess ? "on" : "off"}.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 self-start sm:self-center"
                      onClick={() => setAccessDialogOpen(true)}
                    >
                      Configure access
                    </Button>
                  </div>

                  <Dialog
                    open={accessDialogOpen}
                    onOpenChange={setAccessDialogOpen}
                  >
                    <DialogContent className="sm:max-w-md">
                      <DialogHeader>
                        <DialogTitle>Access settings</DialogTitle>
                        <DialogDescription>
                          Choose who can open this sandbox and whether guests
                          can use it without a full account.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-6">
                        <RadioGroup
                          value={sandboxDraft.mode}
                          onValueChange={(value) =>
                            onDraftChange((draft) => ({
                              ...draft,
                              mode: value as SandboxMode,
                            }))
                          }
                          className="grid gap-2"
                        >
                          <label
                            htmlFor="access-mode-link"
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
                          >
                            <RadioGroupItem
                              value="any_signed_in_with_link"
                              id="access-mode-link"
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">
                                Anyone with the link
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Any signed-in user with the link can open this
                                sandbox.
                              </span>
                            </span>
                          </label>
                          <label
                            htmlFor="access-mode-invite"
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
                          >
                            <RadioGroupItem
                              value="invited_only"
                              id="access-mode-invite"
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">
                                Invited users only
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Only people you invite by email can open this
                                sandbox. Workspace membership does not grant
                                access by itself.
                              </span>
                            </span>
                          </label>
                        </RadioGroup>

                        {sandboxDraft.mode === "invited_only" ? (
                          <div className="space-y-3 rounded-xl border border-border/70 bg-card/50 p-4">
                            <p className="text-xs text-muted-foreground">
                              Invite-only is email-based. Workspace membership
                              does not auto-include everyone—you invite each
                              address (or use Share below for the full list).
                            </p>
                            <div className="space-y-2">
                              <p className="text-sm font-semibold text-foreground">
                                Invite people
                              </p>
                              <Label
                                htmlFor="access-invite-email"
                                className="text-xs font-medium text-muted-foreground"
                              >
                                Email address
                              </Label>
                              <div className="flex gap-2">
                                <Input
                                  id="access-invite-email"
                                  type="email"
                                  autoComplete="email"
                                  placeholder="colleague@company.com"
                                  disabled={!inviteSandboxMember}
                                  value={accessInviteEmail}
                                  onChange={(event) =>
                                    setAccessInviteEmail(event.target.value)
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void handleAccessInvite();
                                    }
                                  }}
                                />
                                <Button
                                  type="button"
                                  className="shrink-0"
                                  disabled={
                                    !inviteSandboxMember ||
                                    !accessInviteEmail.trim() ||
                                    accessInviteBusy
                                  }
                                  onClick={() => void handleAccessInvite()}
                                >
                                  {accessInviteBusy &&
                                  accessInviteEmail.trim() ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    "Invite"
                                  )}
                                </Button>
                              </div>
                              {!inviteSandboxMember ? (
                                <p className="text-xs text-muted-foreground">
                                  Save the sandbox to invite people by email and
                                  manage the share link.
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        <div className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-card/50 px-4 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              Allow guest access
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              When the link mode allows it, guests can open
                              without a full account.
                            </p>
                          </div>
                          <Switch
                            className="shrink-0"
                            checked={sandboxDraft.allowGuestAccess}
                            onCheckedChange={(checked) =>
                              onDraftChange((draft) => ({
                                ...draft,
                                allowGuestAccess: checked,
                              }))
                            }
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          type="button"
                          onClick={() => setAccessDialogOpen(false)}
                        >
                          Done
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {savedSandbox ? (
                    <SandboxShareSection
                      sandbox={savedSandbox}
                      workspaceName={workspaceName}
                      appearance="builder"
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Save the sandbox to manage invitations, rotate the share
                      link, and copy the public URL.
                    </p>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Welcome dialog */}
          <div
            ref={(el) => {
              sectionRefs.current.welcome = el;
            }}
          >
            <Collapsible
              open={openMap.welcome ?? false}
              onOpenChange={(o) => setSectionOpen("welcome", o)}
            >
              <SetupSectionCollapsibleTrigger
                step={4}
                title="Welcome Dialog"
                statusKind={statuses.welcome}
              />
              <CollapsibleContent className="pt-3 pb-1">
                <div className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Shown on first open</p>
                      <p className="text-xs text-muted-foreground">
                        Host-authored intro shown when a tester opens the
                        sandbox.
                      </p>
                    </div>
                    <Switch
                      checked={sandboxDraft.welcomeDialog.enabled}
                      onCheckedChange={(checked) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          welcomeDialog: {
                            ...draft.welcomeDialog,
                            enabled: checked,
                          },
                        }))
                      }
                    />
                  </div>
                  {sandboxDraft.welcomeDialog.enabled ? (
                    <div className="space-y-2">
                      <Label htmlFor="welcome-body">Welcome content</Label>
                      <Textarea
                        id="welcome-body"
                        rows={5}
                        value={sandboxDraft.welcomeDialog.body}
                        onChange={(event) =>
                          onDraftChange((draft) => ({
                            ...draft,
                            welcomeDialog: {
                              ...draft.welcomeDialog,
                              body: event.target.value,
                            },
                          }))
                        }
                        placeholder="What testers should know before they start…"
                      />
                      <p className="text-xs text-muted-foreground">
                        Trust and disclosure copy is added automatically in the
                        hosted experience.
                      </p>
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Feedback */}
          <div
            ref={(el) => {
              sectionRefs.current.feedback = el;
            }}
          >
            <Collapsible
              open={openMap.feedback ?? false}
              onOpenChange={(o) => setSectionOpen("feedback", o)}
            >
              <SetupSectionCollapsibleTrigger
                step={5}
                title="Feedback"
                statusKind={statuses.feedback}
              />
              <CollapsibleContent className="pt-3 pb-1">
                <div className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Tester feedback</p>
                      <p className="text-xs text-muted-foreground">
                        Prompt for ratings and comments during the run.
                      </p>
                    </div>
                    <Switch
                      checked={sandboxDraft.feedbackDialog.enabled}
                      onCheckedChange={(checked) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          feedbackDialog: {
                            ...draft.feedbackDialog,
                            enabled: checked,
                          },
                        }))
                      }
                    />
                  </div>
                  {sandboxDraft.feedbackDialog.enabled ? (
                    <>
                      <div className="space-y-2">
                        <Label>Every N tool calls</Label>
                        <p className="text-xs text-muted-foreground">
                          The hosted session counts completed tool calls before
                          showing the next feedback prompt. It does not mean
                          “every N user messages.”
                        </p>
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={sandboxDraft.feedbackDialog.everyNToolCalls}
                          onChange={(event) => {
                            const n = Number.parseInt(event.target.value, 10);
                            onDraftChange((draft) => ({
                              ...draft,
                              feedbackDialog: {
                                ...draft.feedbackDialog,
                                everyNToolCalls: Number.isFinite(n)
                                  ? Math.max(1, n)
                                  : 1,
                              },
                            }));
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="feedback-hint">Prompt hint</Label>
                        <Textarea
                          id="feedback-hint"
                          rows={3}
                          value={sandboxDraft.feedbackDialog.promptHint}
                          onChange={(event) =>
                            onDraftChange((draft) => ({
                              ...draft,
                              feedbackDialog: {
                                ...draft.feedbackDialog,
                                promptHint: event.target.value,
                              },
                            }))
                          }
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Advanced */}
          <div
            ref={(el) => {
              sectionRefs.current.advanced = el;
            }}
          >
            <Collapsible
              open={openMap.advanced ?? false}
              onOpenChange={(o) => setSectionOpen("advanced", o)}
            >
              <SetupSectionCollapsibleTrigger
                step={6}
                title="Advanced"
                statusKind="collapsed"
              />
              <CollapsibleContent className="pt-3 pb-1">
                <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
                  <div className="space-y-2">
                    <Label htmlFor="setup-prompt">System prompt</Label>
                    <Textarea
                      id="setup-prompt"
                      rows={8}
                      value={sandboxDraft.systemPrompt}
                      onChange={(event) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          systemPrompt: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Temperature</Label>
                      <span className="text-sm text-muted-foreground">
                        {sandboxDraft.temperature.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={2}
                      step={0.05}
                      value={[sandboxDraft.temperature]}
                      onValueChange={(values) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          temperature: values[0] ?? 0.7,
                        }))
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/60 px-4 py-4">
                    <div>
                      <p className="text-sm font-medium">
                        Require tool approval
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Visitors must approve tool calls before execution.
                      </p>
                    </div>
                    <Switch
                      checked={sandboxDraft.requireToolApproval}
                      onCheckedChange={(checked) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          requireToolApproval: checked,
                        }))
                      }
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

export { isInsecureUrl, updateSelectedServerIds };
