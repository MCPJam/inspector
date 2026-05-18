import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";
import type { HostAttentionIssue, HostFocusTabId } from "../types";
import { countIssuesByTab, fieldsWithIssues } from "./useHostDraftValidation";
import { AppearanceTab } from "./AppearanceTab";
import { BehaviorTab } from "./BehaviorTab";
import { ProtocolTab } from "./ProtocolTab";
import { AppsExtensionTab } from "./AppsExtensionTab";
import { ServersTab } from "./ServersTab";
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
  initialSelectedServerId: string | null;
  hostDisplayName: string;
  onHostDisplayNameChange: (value: string) => void;
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
  availableServers: ReadonlyArray<{
    id: string;
    name: string;
    url?: string | null;
    connectionStatus?:
      | "connected"
      | "connecting"
      | "failed"
      | "disconnected"
      | "oauth-flow"
      | "unknown";
  }>;
  onAddServer: () => void;
  onClose: () => void;
}

export function HostFocusPanel({
  hostId,
  tab,
  onTabChange,
  initialSelectedServerId,
  hostDisplayName,
  onHostDisplayNameChange,
  draft,
  onDraftChange,
  attention,
  availableServers,
  onAddServer,
  onClose,
}: HostFocusPanelProps) {
  const issuesByTab = countIssuesByTab(attention);
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
        <HostFocusTabBar
          tab={tab}
          onTabChange={onTabChange}
          issuesByTab={issuesByTab}
        />
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
          />
        ) : null}
        {tab === "servers" ? (
          <ServersTab
            draft={draft}
            onDraftChange={onDraftChange}
            availableServers={availableServers}
            initialSelectedServerId={initialSelectedServerId}
            onAddServer={onAddServer}
          />
        ) : null}
      </div>
    </div>
  );
}
