import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";
import type { HostAttentionIssue, HostFocusTabId } from "../types";
import { countIssuesByTab, fieldsWithIssues } from "./useHostDraftValidation";
import { BehaviorTab } from "./BehaviorTab";
import { GeneralTab } from "./GeneralTab";
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
  }>;
  onAddServer: () => void;
  onClose: () => void;
}

export function HostFocusPanel({
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
  const generalIssues = fieldsWithIssues(attention, "general");

  return (
    <div className={hostFocusShellRootClass}>
      <HostIdentityRow
        className={cn(hostFocusShellHeaderRowClass, "py-2")}
        hostDisplayName={hostDisplayName}
        onHostDisplayNameChange={onHostDisplayNameChange}
        hasNameIssue={generalIssues.has("hostDisplayName")}
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
        {tab === "general" ? (
          <GeneralTab attention={attention} />
        ) : null}
        {tab === "behavior" ? (
          <BehaviorTab
            draft={draft}
            onDraftChange={onDraftChange}
            attention={attention}
          />
        ) : null}
        {tab === "protocol" ? (
          <ProtocolTab
            draft={draft}
            onDraftChange={onDraftChange}
            attention={attention}
          />
        ) : null}
        {tab === "apps" ? (
          <AppsExtensionTab
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
