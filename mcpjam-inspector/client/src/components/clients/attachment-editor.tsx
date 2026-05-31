import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Save, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@/lib/utils";
import { useHost } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useViews";
import {
  hostConfigDtoToInput,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { BehaviorTab } from "./redesigned/focus/BehaviorTab";
import { ProtocolTab } from "./redesigned/focus/ProtocolTab";
import { AppsExtensionTab } from "./redesigned/focus/AppsExtensionTab";
import {
  hostFocusShellDialogChromeClass,
  hostFocusShellHeaderRowClass,
  hostFocusShellScrollClass,
} from "./redesigned/focus/client-focus-shell";
import { ServerSelectionList } from "./server-selection-list";

/**
 * Phase 3 — AttachmentEditor modal.
 *
 * Per-attachment editing surface for suite/chatbox host attachments
 * (`serverAttachment` table, scope='suite'|'chatbox'). The four tabs:
 *
 *   - Behavior, Protocol, Apps — show the bound client's profile in
 *     read-only mode (edits to those flow through the owning Client
 *     surface, not this modal).
 *   - Servers — the editable tab. Required servers from the host's
 *     hostConfig render locked; optional opt-ins live on the
 *     attachment row (`enabledOptionalServerIds`).
 *
 * The modal is presentational + local-state. The parent owns the
 * canonical attachment array (today's eval suite editor draft) and is
 * called back via `onSave({ enabledOptionalServerIds })`. The parent
 * is responsible for persisting through whatever mutation it already
 * uses — `replaceSuiteHostAttachments` for suites, the chatbox host
 * binding for chatboxes. No new mutation lands with this PR.
 *
 * Cancel discards local edits. Save propagates. Click-out and Esc
 * route through the same close path; we don't gate on dirtiness for
 * this modal (the changeset is small and reversible by reopening).
 */

export type AttachmentEditorScope = "suite" | "chatbox";

type AttachmentEditorProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;

  /** Scope discriminator; surfaced in the header. */
  scope: AttachmentEditorScope;
  /** The host whose identity drives the read-only Behavior/Protocol/Apps tabs. */
  hostId: string;
  projectId: string;
  isAuthenticated: boolean;

  /**
   * Current attachment selection — controlled by the parent. PR B: the
   * attachment owns its full server pick from the project pool; no
   * required/optional split, no inheritance from the host.
   */
  selectedServerIds: ReadonlyArray<string>;

  /**
   * Called when the user clicks Save. Closes the modal afterwards via
   * `onOpenChange(false)`. The parent persists.
   */
  onSave: (next: { selectedServerIds: string[] }) => void | Promise<void>;
};

export function AttachmentEditor({
  open,
  onOpenChange,
  scope,
  hostId,
  projectId,
  isAuthenticated,
  selectedServerIds,
  onSave,
}: AttachmentEditorProps) {
  const { host, isLoading } = useHost({ isAuthenticated, hostId });
  const { servers: projectServers = [] } = useProjectServers({
    isAuthenticated,
    projectId,
  });

  // Local draft so toggles don't propagate until Save. Reset whenever
  // the modal opens or the upstream selection changes (e.g. another
  // tab edited it).
  const [draftSelected, setDraftSelected] = useState<string[]>(
    () => [...selectedServerIds],
  );
  useEffect(() => {
    if (open) setDraftSelected([...selectedServerIds]);
  }, [open, selectedServerIds]);

  const [activeTab, setActiveTab] =
    useState<"servers" | "behavior" | "protocol" | "apps">("servers");
  useEffect(() => {
    // Always land on the Servers tab when (re)opening — that's the
    // only editable surface, and the read-only tabs are reference
    // material the user dips into rather than navigates to.
    if (open) setActiveTab("servers");
  }, [open]);

  // The host config flows into the read-only tabs as an
  // HostConfigInputV2. `hostConfigDtoToInput` is the canonical
  // conversion; we memoize so identity stays stable across renders.
  const readOnlyDraft: HostConfigInputV2 | null = useMemo(() => {
    if (!host) return null;
    return hostConfigDtoToInput(host.config);
  }, [host]);

  const selectionSet = useMemo(
    () => new Set(draftSelected),
    [draftSelected],
  );

  const handleToggleServer = useCallback(
    (serverId: string, next: boolean) => {
      setDraftSelected((prev) => {
        const set = new Set(prev);
        if (next) set.add(serverId);
        else set.delete(serverId);
        return Array.from(set);
      });
    },
    [],
  );


  const [isSaving, setIsSaving] = useState(false);
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await onSave({ selectedServerIds: draftSelected });
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  }, [draftSelected, onOpenChange, onSave]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // The read-only tabs require a draft. While the host is loading we
  // show a tab-bar skeleton so layout doesn't jump.
  const tabsReady = readOnlyDraft !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        handleClose();
      }}
    >
      <DialogContent
        className={cn(
          "top-10 left-1/2 translate-x-[-50%] translate-y-0",
          "w-[820px] max-w-[calc(100vw-32px)] sm:max-w-[820px]",
          "h-[calc(100vh-80px)]",
          "flex flex-col gap-0 overflow-hidden p-0",
          "rounded-[14px]",
          hostFocusShellDialogChromeClass,
        )}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          Edit {scope} attachment
        </DialogTitle>

        <header
          className={cn(
            hostFocusShellHeaderRowClass,
            "px-4 py-2.5",
          )}
        >
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleClose}
            aria-label="Close"
          >
            <X className="size-3.5" />
          </Button>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold text-foreground">
              {scope === "suite" ? "Suite attachment" : "Chatbox attachment"}
            </span>
            <span className="truncate text-[12.5px] text-muted-foreground">
              {host?.name ?? "Loading…"}
            </span>
            {isLoading ? (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          <Button
            size="sm"
            className="h-7 gap-1 text-[11.5px]"
            onClick={handleSave}
            disabled={isSaving || !tabsReady}
          >
            {isSaving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Save className="size-3" />
            )}
            Save attachment
          </Button>
          <kbd className="ml-1 hidden rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9.5px] text-muted-foreground sm:inline">
            esc
          </kbd>
        </header>

        <div
          className={cn(
            hostFocusShellHeaderRowClass,
            "border-t-0 px-3 py-1",
          )}
        >
          <AttachmentEditorTabBar
            active={activeTab}
            onChange={setActiveTab}
            tabsReady={tabsReady}
          />
        </div>

        <div className={cn(hostFocusShellScrollClass, "px-6 py-5")}>
          {activeTab === "servers" ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Servers from project pool
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  {draftSelected.length} of {projectServers.length} picked
                </span>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                Pick which of this project's servers this {scope} attaches
                to. The bound client's identity (model, prompt, behavior)
                stays the same; only server selection lives here.
              </p>
              <ServerSelectionList
                servers={projectServers.map((s) => ({
                  id: s._id,
                  name: s.name,
                }))}
                selectedIds={selectionSet}
                onToggle={handleToggleServer}
                emptyState={
                  <p className="px-2 py-1 text-xs italic text-muted-foreground">
                    No servers in the project pool yet. Add one in the
                    Connect tab.
                  </p>
                }
                ariaLabel="Project servers"
              />
              {draftSelected.length === 0 && projectServers.length > 0 ? (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
                  Pick at least one server to enable this attachment.
                  {scope === "suite"
                    ? " Eval runs with empty selection fail at run-start."
                    : " Chatbox sessions with empty selection have no tools available."}
                </p>
              ) : null}
            </div>
          ) : null}

          {activeTab === "behavior" && readOnlyDraft ? (
            <BehaviorTab
              draft={readOnlyDraft}
              onDraftChange={NOOP_DRAFT_CHANGE}
              attention={EMPTY_ATTENTION}
              readOnly
            />
          ) : null}

          {activeTab === "protocol" && readOnlyDraft ? (
            <ProtocolTab
              key={hostId}
              draft={readOnlyDraft}
              onDraftChange={NOOP_DRAFT_CHANGE}
              attention={EMPTY_ATTENTION}
              readOnly
            />
          ) : null}

          {activeTab === "apps" && readOnlyDraft ? (
            <AppsExtensionTab
              key={hostId}
              draft={readOnlyDraft}
              onDraftChange={NOOP_DRAFT_CHANGE}
              attention={EMPTY_ATTENTION}
              readOnly
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// readOnly tabs never call this — the design-system disables every
// control they expose — but the prop is required. Define once at module
// scope so we don't churn a new reference on every render.
const NOOP_DRAFT_CHANGE = (_: (prev: HostConfigInputV2) => HostConfigInputV2) => {
  // intentional no-op (read-only)
};
const EMPTY_ATTENTION: ReadonlyArray<never> = [];

type AttachmentEditorTabBarProps = {
  active: "servers" | "behavior" | "protocol" | "apps";
  onChange: (next: "servers" | "behavior" | "protocol" | "apps") => void;
  tabsReady: boolean;
};

function AttachmentEditorTabBar({
  active,
  onChange,
  tabsReady,
}: AttachmentEditorTabBarProps) {
  // Servers comes first — it's the editable tab and the user's reason
  // for opening the modal. The three read-only profile tabs trail for
  // reference.
  const tabs: ReadonlyArray<{
    id: AttachmentEditorTabBarProps["active"];
    label: string;
  }> = [
    { id: "servers", label: "Servers" },
    { id: "behavior", label: "Behavior" },
    { id: "protocol", label: "Protocol" },
    { id: "apps", label: "Apps" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const isReadOnly = tab.id !== "servers";
        const disabled = !tabsReady && isReadOnly;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            disabled={disabled}
            className={cn(
              "h-7 rounded-md px-2.5 text-[11.5px] transition-colors",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {tab.label}
            {isReadOnly ? (
              <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                read-only
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
