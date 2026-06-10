import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import type {
  HostAttentionIssue,
  HostFocusTabId,
  SandboxConfigSubKey,
} from "../types";
import { fieldsWithIssues } from "./useHostDraftValidation";
import { AppearanceTab } from "./AppearanceTab";
import { BehaviorTab } from "./BehaviorTab";
import { ProtocolTab } from "./ProtocolTab";
import { AppsExtensionTab } from "./AppsExtensionTab";
import { HostFocusTabBar } from "./HostFocusTabBar";
import { HostIdentityRow } from "./HostIdentityRow";
import {
  hostFocusShellHeaderRowClass,
  hostFocusShellRootClass,
  hostFocusShellScrollClass,
} from "./host-focus-shell";

interface HostFocusPanelProps {
  /**
   * Stable host identifier. Used as a React key on the JSON-native tabs so
   * they hard-remount when the user switches hosts — otherwise the
   * mount-time-only content buffer in those tabs goes stale.
   */
  hostId: string;
  tab: HostFocusTabId;
  onTabChange: (next: HostFocusTabId) => void;
  /**
   * Sandbox-config subKey to focus inside the Apps tab when opened from a
   * sandbox-cfg matrix click. Currently threaded through but ignored by
   * the editor (no programmatic JSON key-focus API yet); see
   * `AppsExtensionTab` focusSubKey TODO.
   */
  focusSubKey?: SandboxConfigSubKey;
  hostDisplayName: string;
  onHostDisplayNameChange: (value: string) => void;
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
  onClose: () => void;
  // `availableServers`, `onAddServer`, and `initialSelectedServerId`
  // were dropped when the per-host Servers tab moved to Project
  // Settings → Servers (project-scoped server config rollout). Server
  // selection is no longer a per-host concern; canvas-level "Add
  // server" is wired separately on the parent.
}

export function HostFocusPanel({
  hostId,
  tab,
  onTabChange,
  focusSubKey,
  hostDisplayName,
  onHostDisplayNameChange,
  draft,
  onDraftChange,
  attention,
  onClose,
}: HostFocusPanelProps) {
  // Host-name validation was retagged from "general" → "behavior" when
  // the General tab was removed (see useHostDraftValidation.ts). The
  // identity-row indicator follows the new tag so the input still lights
  // up red when empty.
  const behaviorIssues = fieldsWithIssues(attention, "behavior");

  return (
    <div className={hostFocusShellRootClass}>
      <HostIdentityRow
        className={cn(hostFocusShellHeaderRowClass, "py-2")}
        hostDisplayName={hostDisplayName}
        onHostDisplayNameChange={onHostDisplayNameChange}
        hasNameIssue={behaviorIssues.has("hostDisplayName")}
      />
      <header
        className={cn(
          hostFocusShellHeaderRowClass,
          "items-stretch gap-2 py-1 sm:items-center",
        )}
      >
        <HostFocusTabBar tab={tab} onTabChange={onTabChange} />
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 self-center text-muted-foreground motion-safe:transition-transform motion-safe:duration-150 motion-safe:active:scale-95 hover:text-foreground"
          onClick={onClose}
          aria-label="Close panel"
          title="Close"
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className={hostFocusShellScrollClass}>
        {tab === "behavior" ? (
          <BehaviorTab
            draft={draft}
            onDraftChange={onDraftChange}
            attention={attention}
          />
        ) : null}
        {tab === "appearance" ? (
          <AppearanceTab draft={draft} onDraftChange={onDraftChange} />
        ) : null}
        {tab === "protocol" ? (
          <ProtocolTab
            key={hostId}
            draft={draft}
            onDraftChange={onDraftChange}
            attention={attention}
          />
        ) : null}
        {tab === "apps" ? (
          <AppsExtensionTab
            key={hostId}
            draft={draft}
            onDraftChange={onDraftChange}
            attention={attention}
            focusSubKey={focusSubKey}
          />
        ) : null}
        {/* Servers tab moved to Project Settings → Servers. Persisted
            UI state may still set `tab === "servers"` for legacy
            sessions; we render nothing and the tab bar (which no
            longer surfaces a "servers" entry) will route the user
            elsewhere on next interaction. */}
      </div>
    </div>
  );
}
