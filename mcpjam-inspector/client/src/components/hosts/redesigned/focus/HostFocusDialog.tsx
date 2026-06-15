import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Save, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  shortenSnapshotId,
  type HostAttentionIssue,
  type HostFocusTabId,
} from "../types";
import { fieldsWithIssues } from "./useHostDraftValidation";
import { HostIdentityRow } from "./HostIdentityRow";
import { AppearanceTab } from "./AppearanceTab";
import { BehaviorTab } from "./BehaviorTab";
import { ToolsTab } from "./ToolsTab";
import { ComputerTab } from "./ComputerTab";
import { ProtocolTab } from "./ProtocolTab";
import { AppsExtensionTab } from "./AppsExtensionTab";
import { HostFocusTabBar } from "./HostFocusTabBar";
import {
  activeHostFocusTab,
  useVisibleHostFocusTabs,
} from "./host-focus-tab-defs";
import {
  hostFocusShellDialogChromeClass,
  hostFocusShellHeaderRowClass,
  hostFocusShellScrollClass,
} from "./host-focus-shell";

interface HostFocusDialogProps {
  open: boolean;
  /**
   * Stable host identifier. Used as a React key on the JSON-native tabs so
   * they hard-remount when the user switches hosts.
   */
  hostId: string;
  /** Active tab the dialog should display. */
  tab: HostFocusTabId;
  /** Tab change handler — keyboard nav + header tabs. */
  onTabChange: (next: HostFocusTabId) => void;

  hostDisplayName: string;
  onHostDisplayNameChange: (value: string) => void;

  /** Host metadata for the header chrome. */
  hostName: string;
  snapshotId: string;
  isDirty: boolean;
  isSaving: boolean;
  canSave: boolean;

  /** Draft state — single source of truth (lifted to HostBuilderView). */
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
  // `availableServers`, `onAddServer`, and `initialSelectedServerId`
  // were dropped when the per-host Servers tab moved to Project
  // Settings → Servers.

  /** Header actions. */
  onClose: () => void;
  onRevert: () => void;
  onSave: () => void;
}

export function HostFocusDialog({
  open,
  hostId,
  tab,
  onTabChange,
  hostDisplayName,
  onHostDisplayNameChange,
  hostName,
  snapshotId,
  isDirty,
  isSaving,
  canSave,
  draft,
  onDraftChange,
  attention,
  onClose,
  onRevert,
  onSave,
}: HostFocusDialogProps) {
  // See HostFocusPanel: hostDisplayName is now tagged "behavior" after
  // the General tab was removed.
  const behaviorIssues = fieldsWithIssues(attention, "behavior");
  const totalIssues = attention.length;

  // Tools is GA; Computer is flag-gated (or shown when already attached).
  const visibleTabs = useVisibleHostFocusTabs(draft);
  // Clamp to a visible tab so a hidden tab (e.g. detach + flag off on Computer)
  // can't keep rendering or desync the tab bar.
  const activeTab = activeHostFocusTab(tab, visibleTabs);

  // Click-out / Esc / X all route through this confirm path when the
  // draft is dirty. Without it, the user could lose unsaved work to a
  // stray click on the scrim.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const closeWithGuard = useCallback(() => {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  // Reset the confirm dialog when the parent closes us cleanly.
  useEffect(() => {
    if (!open) setConfirmDiscard(false);
  }, [open]);

  const headerBtnClass =
    "motion-safe:transition-transform motion-safe:duration-150 motion-safe:active:scale-95";

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) return;
          closeWithGuard();
        }}
      >
        <DialogContent
          // Sized to handoff: 820px × calc(100vh-80px), top: 40px. cn merges
          // and tailwind-merge collapses the conflicting top/translate
          // classes from DialogContent's base.
          className={cn(
            "top-10 left-1/2 translate-x-[-50%] translate-y-0",
            "w-[820px] max-w-[calc(100vw-32px)] sm:max-w-[820px]",
            "h-[calc(100vh-80px)]",
            "flex flex-col gap-0 overflow-hidden p-0",
            "rounded-[14px]",
            hostFocusShellDialogChromeClass,
          )}
          showCloseButton={false}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            closeWithGuard();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            closeWithGuard();
          }}
        >
          <DialogTitle className="sr-only">
            Edit client configuration
          </DialogTitle>

          <header className={cn(hostFocusShellHeaderRowClass, "px-4 py-2.5")}>
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                headerBtnClass,
                "size-7 shrink-0 text-muted-foreground hover:text-foreground",
              )}
              onClick={closeWithGuard}
              aria-label="Close"
            >
              <X className="size-3.5" />
            </Button>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold text-foreground">
                MCPJam
              </span>
              <span className="truncate text-[12.5px] text-muted-foreground">
                {hostName || "Untitled host"}
              </span>
              <span
                className="font-mono text-[11px] text-muted-foreground"
                title="Saved snapshot id"
              >
                {shortenSnapshotId(snapshotId)}
              </span>
              {isDirty ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-500 shadow-[0_0_8px_rgb(245_158_11_/_0.35)]"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              ) : null}
              {totalIssues > 0 ? (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-200"
                >
                  {totalIssues} {totalIssues === 1 ? "issue" : "issues"}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-primary/35 bg-primary/10 text-[10px] text-primary"
                >
                  Ready
                </Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                headerBtnClass,
                "h-7 gap-1 text-[11.5px] text-muted-foreground hover:text-foreground",
              )}
              onClick={onRevert}
              disabled={!isDirty || isSaving}
            >
              <RotateCcw className="size-3" /> Revert
            </Button>
            <Button
              size="sm"
              className={cn(headerBtnClass, "h-7 gap-1 text-[11.5px]")}
              onClick={onSave}
              disabled={!canSave}
            >
              {isSaving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Save className="size-3" />
              )}
              Save host
            </Button>
            <kbd className="ml-1 hidden rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9.5px] text-muted-foreground sm:inline">
              esc
            </kbd>
          </header>

          <HostIdentityRow
            className={cn(hostFocusShellHeaderRowClass, "border-t-0 px-4 py-2")}
            hostDisplayName={hostDisplayName}
            onHostDisplayNameChange={onHostDisplayNameChange}
            hasNameIssue={behaviorIssues.has("hostDisplayName")}
          />

          <div
            className={cn(
              hostFocusShellHeaderRowClass,
              "border-t-0 py-1 pl-3 pr-4",
            )}
          >
            <HostFocusTabBar
              tab={activeTab}
              onTabChange={onTabChange}
              tabs={visibleTabs}
            />
          </div>

          <div className={cn(hostFocusShellScrollClass, "px-6 py-5")}>
            {activeTab === "behavior" ? (
              <BehaviorTab
                draft={draft}
                onDraftChange={onDraftChange}
                attention={attention}
              />
            ) : null}
            {activeTab === "tools" ? (
              <ToolsTab draft={draft} onDraftChange={onDraftChange} />
            ) : null}
            {activeTab === "computer" ? (
              <ComputerTab draft={draft} onDraftChange={onDraftChange} />
            ) : null}
            {activeTab === "protocol" ? (
              <ProtocolTab
                key={hostId}
                draft={draft}
                onDraftChange={onDraftChange}
                attention={attention}
              />
            ) : null}
            {activeTab === "apps" ? (
              <AppsExtensionTab
                key={hostId}
                draft={draft}
                onDraftChange={onDraftChange}
                attention={attention}
              />
            ) : null}
            {/* Servers tab moved to Project Settings → Servers. Legacy
                state may still report `tab === "servers"`; we render
                nothing and the tab bar no longer surfaces the entry. */}
            {activeTab === "appearance" ? (
              <AppearanceTab draft={draft} onDraftChange={onDraftChange} />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* Discard-changes confirm. Independent Dialog so it can layer on
          top of the focus overlay when the user tries to dismiss with
          unsaved changes. */}
      <Dialog
        open={confirmDiscard}
        onOpenChange={(next) => !next && setConfirmDiscard(false)}
      >
        <DialogContent className="max-w-md">
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Discard changes?</h2>
            <p className="text-[12.5px] text-muted-foreground">
              Your draft hasn't been saved as a snapshot yet. Closing now will
              revert to the last saved configuration.
            </p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDiscard(false)}
              >
                Keep editing
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setConfirmDiscard(false);
                  onRevert();
                  onClose();
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
