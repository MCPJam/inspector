import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Separator } from "@mcpjam/design-system/separator";
import { Slider } from "@mcpjam/design-system/slider";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  chatboxAccessPresetFromSettings,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import { listHostStyles } from "@/lib/host-styles";
import { isMCPJamProvidedModel, SUPPORTED_MODELS } from "@/shared/types";
import { cn } from "@/lib/utils";
import type { ChatboxDraftConfig } from "./types";

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

const sectionStatusMetaClassName =
  "inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground";

function SectionStatusBadge({ kind }: { kind: SectionStatusKind }) {
  switch (kind) {
    case "complete":
      return (
        <span className={sectionStatusMetaClassName}>
          <Check className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          Done
        </span>
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
      return <span className={sectionStatusMetaClassName}>Optional</span>;
    case "default_on":
      return <span className={sectionStatusMetaClassName}>Default on</span>;
    case "collapsed":
      return <span className={sectionStatusMetaClassName}>Collapsed</span>;
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
            title={insecure ? "Chatboxes require HTTPS server URLs" : undefined}
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
  onToggleSelection,
  onOpenAdd,
}: {
  workspaceServers: RemoteServer[];
  selectedServerIds: string[];
  onToggleSelection: (serverId: string, checked: boolean) => void;
  onOpenAdd: () => void;
}) {
  const availableServers = workspaceServers.filter(
    (server) => server.transportType === "http",
  );
  const selectedServerSet = new Set(selectedServerIds);
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
      <h3 className="text-sm font-semibold">MCP servers</h3>

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
          {selectedServers.map((server) => (
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
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function computeSectionStatuses(
  draft: ChatboxDraftConfig,
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
  chatboxDraft,
  savedChatbox,
  workspaceServers,
  focusedSection,
  /** True when creating a chatbox that has never been saved (no chatbox id yet). */
  isUnsavedNewDraft,
  onDraftChange,
  onOpenAddServer,
  onToggleServer,
  onCloseMobile,
  /** When the chatbox is saved, invite by email from the Access section (invite-only draft). */
  inviteChatboxMember,
  workspaceName,
}: {
  chatboxDraft: ChatboxDraftConfig;
  savedChatbox: ChatboxSettings | null;
  workspaceServers: RemoteServer[];
  workspaceName?: string | null;
  focusedSection: SetupSectionId | null;
  isUnsavedNewDraft: boolean;
  onDraftChange: (
    updater: (draft: ChatboxDraftConfig) => ChatboxDraftConfig,
  ) => void;
  onOpenAddServer: () => void;
  onToggleServer: (serverId: string, checked: boolean) => void;
  onCloseMobile?: () => void;
  inviteChatboxMember?: (email: string) => Promise<void>;
}) {
  const statuses = useMemo(
    () => computeSectionStatuses(chatboxDraft, workspaceServers),
    [chatboxDraft, workspaceServers],
  );

  const sectionRefs = useRef<
    Partial<Record<SetupSectionId, HTMLDivElement | null>>
  >({});

  const [openMap, setOpenMap] = useState<
    Partial<Record<SetupSectionId, boolean>>
  >({});
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
    if (!inviteChatboxMember) return;
    const normalized = accessInviteEmail.trim().toLowerCase();
    if (!normalized) return;
    setAccessInviteBusy(true);
    try {
      await inviteChatboxMember(normalized);
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
                    <Label htmlFor="setup-chatbox-name">Chatbox name</Label>
                    <Input
                      id="setup-chatbox-name"
                      value={chatboxDraft.name}
                      onChange={(event) =>
                        onDraftChange((draft) => ({
                          ...draft,
                          name: event.target.value,
                        }))
                      }
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>Host style</Label>
                    <div className="grid gap-2">
                      {listHostStyles().map((host) => {
                        const selected = chatboxDraft.hostStyle === host.id;
                        return (
                          <button
                            key={host.id}
                            type="button"
                            className={`flex items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-colors ${
                              selected
                                ? "border-primary/50 bg-primary/10"
                                : "border-border/70 bg-card/60 hover:bg-muted/20"
                            }`}
                            onClick={() =>
                              onDraftChange((draft) => ({
                                ...draft,
                                hostStyle: host.id,
                              }))
                            }
                          >
                            <img
                              src={host.logoSrc}
                              alt=""
                              className="size-6 rounded-md object-contain"
                            />
                            <div>
                              <p className="font-medium">{host.shortLabel}</p>
                              <p className="text-xs text-muted-foreground">
                                {host.pickerDescription}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Model</Label>
                    <Select
                      value={chatboxDraft.modelId}
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
                    selectedServerIds={chatboxDraft.selectedServerIds}
                    onToggleSelection={onToggleServer}
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
                  {savedChatbox ? (
                    <ChatboxShareSection
                      chatbox={savedChatbox}
                      workspaceName={workspaceName}
                    />
                  ) : (
                    <>
                      <div className="space-y-6">
                        <RadioGroup
                          value={chatboxAccessPresetFromSettings(
                            chatboxDraft.mode,
                            chatboxDraft.allowGuestAccess,
                          )}
                          onValueChange={(value) =>
                            onDraftChange((draft) => ({
                              ...draft,
                              ...settingsFromChatboxAccessPreset(
                                value as ChatboxAccessPreset,
                              ),
                            }))
                          }
                          className="grid gap-2"
                        >
                          <label
                            htmlFor="access-preset-workspace"
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
                          >
                            <RadioGroupItem
                              value="workspace"
                              id="access-preset-workspace"
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">
                                {workspaceName?.trim() || "Workspace"}
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Signed-in members of this workspace can open the
                                chatbox with the link. Guests cannot.
                              </span>
                            </span>
                          </label>
                          <label
                            htmlFor="access-preset-invited"
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
                          >
                            <RadioGroupItem
                              value="invited_only"
                              id="access-preset-invited"
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">
                                Invited users only
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Only people you invite by email can open this
                                chatbox.
                              </span>
                            </span>
                          </label>
                          <label
                            htmlFor="access-preset-link-guests"
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
                          >
                            <RadioGroupItem
                              value="link_guests"
                              id="access-preset-link-guests"
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">
                                Anyone with the link (guests included)
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Anyone with the link can open the chatbox,
                                including guests without an account.
                              </span>
                            </span>
                          </label>
                        </RadioGroup>

                        {chatboxDraft.mode === "invited_only" ? (
                          <div className="space-y-3 rounded-xl border border-border/70 bg-card/50 p-4">
                            <p className="text-xs text-muted-foreground">
                              Invite-only is email-based. Workspace membership
                              does not auto-include everyone—you invite each
                              address (or use the section below once the chatbox
                              is saved).
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
                                  disabled={!inviteChatboxMember}
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
                                    !inviteChatboxMember ||
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
                              {!inviteChatboxMember ? (
                                <p className="text-xs text-muted-foreground">
                                  Save the chatbox to invite people by email.
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Save the chatbox to manage invitations and access
                        settings for the hosted link.
                      </p>
                    </>
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
                        A short intro shown the first time someone opens your
                        chatbox link.
                      </p>
                    </div>
                    <Switch
                      checked={chatboxDraft.welcomeDialog.enabled}
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
                  {chatboxDraft.welcomeDialog.enabled ? (
                    <div className="space-y-2">
                      <Label htmlFor="welcome-body">Welcome content</Label>
                      <Textarea
                        id="welcome-body"
                        rows={5}
                        value={chatboxDraft.welcomeDialog.body}
                        onChange={(event) =>
                          onDraftChange((draft) => ({
                            ...draft,
                            welcomeDialog: {
                              ...draft.welcomeDialog,
                              body: event.target.value,
                            },
                          }))
                        }
                        placeholder="What your audience should know before they start…"
                      />
                      <p className="text-xs text-muted-foreground">
                        {chatboxDraft.welcomeDialog.body.trim()
                          ? "Shown once, the first time someone opens your chatbox link."
                          : "Leave blank to skip — no welcome will be shown."}
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
                      checked={chatboxDraft.feedbackDialog.enabled}
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
                  {chatboxDraft.feedbackDialog.enabled ? (
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
                          value={chatboxDraft.feedbackDialog.everyNToolCalls}
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
                          value={chatboxDraft.feedbackDialog.promptHint}
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
                      value={chatboxDraft.systemPrompt}
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
                        {chatboxDraft.temperature.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={2}
                      step={0.05}
                      value={[chatboxDraft.temperature]}
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
                      checked={chatboxDraft.requireToolApproval}
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
