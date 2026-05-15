import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { HostConfigEditor } from "@/components/host-config/HostConfigEditor";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";
import { ServerConnectionOverrideSection } from "./ServerConnectionOverrideSection";
import type {
  HostSectionStatusKind,
  HostSetupSectionId,
} from "./host-builder-types";

const sectionStatusMetaClassName =
  "inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground";

function SectionStatusBadge({ kind }: { kind: HostSectionStatusKind }) {
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
  statusKind: HostSectionStatusKind;
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

export function computeHostSectionStatuses(
  draft: HostConfigInputV2,
): Record<HostSetupSectionId, HostSectionStatusKind> {
  const basics: HostSectionStatusKind =
    draft.modelId.trim() !== "" ? "complete" : "attention";
  const totalServers = draft.serverIds.length + draft.optionalServerIds.length;
  const servers: HostSectionStatusKind =
    totalServers > 0 ? "complete" : "optional";
  return { basics, servers };
}

export interface HostSetupChecklistPanelProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (draft: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  availableServers: ReadonlyArray<{ id: string; name: string }>;
  focusedSection: HostSetupSectionId | null;
  onValidityChange: (hasError: boolean) => void;
  onOpenAddServer: () => void;
}

export function HostSetupChecklistPanel({
  draft,
  onDraftChange,
  availableServers,
  focusedSection,
  onValidityChange,
  onOpenAddServer,
}: HostSetupChecklistPanelProps) {
  const statuses = useMemo(() => computeHostSectionStatuses(draft), [draft]);

  const sectionRefs = useRef<
    Partial<Record<HostSetupSectionId, HTMLDivElement | null>>
  >({});

  const [openMap, setOpenMap] = useState<
    Partial<Record<HostSetupSectionId, boolean>>
  >({});
  const didAutoExpandRef = useRef(false);

  // First-mount: auto-expand the first attention section. Mirrors the
  // chatbox setup-checklist behaviour at setup-checklist-panel.tsx:411-426.
  useEffect(() => {
    if (didAutoExpandRef.current) return;
    const order: HostSetupSectionId[] = ["basics", "servers"];
    const firstIncomplete = order.find((id) => statuses[id] === "attention");
    if (firstIncomplete) {
      setOpenMap((prev) => ({ ...prev, [firstIncomplete]: true }));
    } else {
      // No attention sections — still expand basics so the user lands on
      // something rather than a wall of collapsed pills.
      setOpenMap((prev) =>
        prev.basics === undefined ? { ...prev, basics: true } : prev,
      );
    }
    didAutoExpandRef.current = true;
  }, [statuses]);

  // When the canvas requests focus, open that section and scroll it into view.
  useEffect(() => {
    if (!focusedSection) return;
    setOpenMap((prev) => ({ ...prev, [focusedSection]: true }));
    const el = sectionRefs.current[focusedSection];
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedSection]);

  const setSectionOpen = (id: HostSetupSectionId, open: boolean) => {
    setOpenMap((prev) => ({ ...prev, [id]: open }));
  };

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-4 pb-12">
          {/* 1. Basics */}
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
                <div className="rounded-xl border border-border/50 bg-card/40 p-4">
                  <HostConfigEditor
                    value={draft}
                    onChange={(next) => onDraftChange(() => next)}
                    owner="host"
                    availableServers={availableServers}
                    onValidityChange={onValidityChange}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* 2. Servers */}
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
                <div className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">MCP servers</h3>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={onOpenAddServer}
                    >
                      <Plus className="size-4" />
                      Add server
                    </Button>
                  </div>
                  <ServerConnectionOverrideSection
                    serverIds={draft.serverIds}
                    optionalServerIds={draft.optionalServerIds}
                    projectServers={[...availableServers]}
                    overrides={draft.serverConnectionOverrides ?? {}}
                    onChange={(overrides) =>
                      onDraftChange((prev) => ({
                        ...prev,
                        serverConnectionOverrides: overrides,
                      }))
                    }
                    onServerSelectionChange={(serverIds, optionalServerIds) =>
                      onDraftChange((prev) => ({
                        ...prev,
                        serverIds,
                        optionalServerIds,
                      }))
                    }
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
