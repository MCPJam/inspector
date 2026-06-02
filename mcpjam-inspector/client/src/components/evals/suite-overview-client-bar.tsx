import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  Check,
  ChevronDown,
  GitCompare,
  Globe,
  Info,
  Settings2,
  Users,
} from "lucide-react";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { type HostListItem } from "@/hooks/useClients";
import {
  buildClientsPath,
  buildHostComparePath,
  navigateApp,
  routePaths,
} from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import type { HostAttachmentDraft } from "./client-attachments-editor";
import type { EvalSuite } from "./types";
import { ServerAttachmentPicker } from "./server-attachment-picker";

export interface SuiteOverviewHostBarProps {
  suite: EvalSuite;
  /**
   * Hosts available in the suite's project. The parent owns the Convex
   * query (via {@link useHostList}) so this component stays renderable in
   * test environments that don't mount a Convex provider.
   */
  projectHosts: HostListItem[];
  readOnly?: boolean;
  onUpdate?: (attachments: HostAttachmentDraft[]) => Promise<void>;
  onUpdateServerAttachment?: (serverAttachmentId: string) => Promise<void>;
  /** Merged with the outer bar container (e.g. tighter padding in {@link SuiteHeader}). */
  className?: string;
  /**
   * `panel` = card surface (default). `inline` = no card chrome for embedding
   * in a header row.
   */
  containerVariant?: "panel" | "inline";
}

export function SuiteOverviewClientBar({
  suite,
  projectHosts,
  readOnly = false,
  onUpdate,
  onUpdateServerAttachment,
  className,
  containerVariant = "panel",
}: SuiteOverviewHostBarProps) {
  const initialAttachments = useMemo<HostAttachmentDraft[]>(
    () =>
      (suite.hostAttachments ?? []).map((attachment) => ({
        namedHostId: attachment.namedHostId,
        enabledOptionalServerIds: attachment.enabledOptionalServerIds,
      })),
    [suite.hostAttachments],
  );

  const [attachments, setAttachments] =
    useState<HostAttachmentDraft[]>(initialAttachments);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Keep optimistic local state in sync with server-resolved suite data.
  useEffect(() => {
    setAttachments(initialAttachments);
  }, [initialAttachments]);

  const hostNameByAttachment = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const attachment of suite.hostAttachments ?? []) {
      map.set(attachment.namedHostId, attachment.hostName);
    }
    return map;
  }, [suite.hostAttachments]);

  // Version counter so concurrent persists can't race: a stale failure must
  // not roll back state that a newer successful call has already written.
  const persistVersionRef = useRef(0);
  const persist = useCallback(
    async (next: HostAttachmentDraft[]) => {
      if (!onUpdate) return;
      const previous = attachments;
      const myVersion = ++persistVersionRef.current;
      setAttachments(next);
      try {
        await onUpdate(next);
      } catch (error) {
        // Only roll back if no later persist call has been issued since this
        // one started — otherwise we'd clobber a newer optimistic state.
        if (persistVersionRef.current === myVersion) {
          setAttachments(previous);
        }
        console.error("Failed to update suite host attachments", error);
      }
    },
    [attachments, onUpdate],
  );

  const handleToggleHost = async (host: HostListItem) => {
    if (readOnly || !onUpdate) return;
    const isAttached = attachments.some((a) => a.namedHostId === host.hostId);
    if (isAttached) {
      // A suite needs at least one client to be runnable; refuse the last
      // detach instead of letting the bar fall into the empty state.
      if (attachments.length <= 1) return;
      await persist(attachments.filter((a) => a.namedHostId !== host.hostId));
      return;
    }
    await persist([
      ...attachments,
      { namedHostId: host.hostId, enabledOptionalServerIds: [] },
    ]);
  };

  const openClientsPage = () => {
    navigateApp(routePaths.clients);
  };

  const editable = Boolean(onUpdate) && !readOnly;

  const canCompare = attachments.length >= 2;
  const handleOpenCompare = () => {
    navigateApp(
      buildHostComparePath(attachments.map((a) => a.namedHostId)),
    );
  };
  const compareButton = canCompare ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-foreground outline-none transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring dark:bg-background"
          aria-label="Compare attached clients"
          onClick={handleOpenCompare}
        >
          <GitCompare className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Compare attached clients side by side</TooltipContent>
    </Tooltip>
  ) : null;

  const triggerLabel = useMemo(() => {
    if (attachments.length === 0) return "No clients · pick one";
    const firstName =
      hostNameByAttachment.get(attachments[0]!.namedHostId) ??
      projectHosts.find((h) => h.hostId === attachments[0]!.namedHostId)
        ?.name ??
      attachments[0]!.namedHostId;
    return firstName;
  }, [attachments, hostNameByAttachment, projectHosts]);

  const extraAttached = attachments.length > 1 ? attachments.length - 1 : 0;
  const triggerLogoLabel =
    attachments.length > 0 ? (triggerLabel ?? undefined) : undefined;

  const clientPicker = (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={!editable}
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            attachments.length === 0
              ? "border-warning/50 bg-warning/50 hover:brightness-95"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            !editable && "cursor-not-allowed opacity-50",
          )}
          aria-label="Attached clients"
        >
          {triggerLogoLabel ? (
            <HostLogoMark label={triggerLogoLabel} />
          ) : (
            <Users className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {extraAttached > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              +{extraAttached}
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start" sideOffset={4}>
        <div className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Clients
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="What is a client attachment?"
                  className="rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px]">
                <p className="text-xs leading-snug">
                  Clients are the MCP hosts this suite evaluates. Attach
                  one or more to compare how each handles the same
                  scenarios.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          {projectHosts.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No clients in this project yet — add one below.
            </p>
          ) : null}
          {projectHosts.map((host) => {
            const isAttached = attachments.some(
              (a) => a.namedHostId === host.hostId,
            );
            const isLastAttached = isAttached && attachments.length === 1;
            return (
              <div key={host.hostId} className="group/host relative">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block">
                      <button
                        type="button"
                        onClick={() => void handleToggleHost(host)}
                        disabled={isLastAttached}
                        className={cn(
                          "flex w-full items-center gap-2 rounded py-1.5 pl-2 pr-9 text-left text-sm",
                          "hover:bg-accent hover:text-accent-foreground",
                          isAttached && "bg-accent/50",
                          isLastAttached &&
                            "cursor-not-allowed opacity-60 hover:bg-transparent",
                        )}
                      >
                        <Check
                          className={cn(
                            "size-3.5 shrink-0",
                            isAttached ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <HostLogoMark label={host.name} />
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {host.name}
                        </span>
                      </button>
                    </span>
                  </TooltipTrigger>
                  {isLastAttached ? (
                    <TooltipContent side="right">
                      <p className="text-xs">
                        Attach another client first
                      </p>
                    </TooltipContent>
                  ) : null}
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Configure ${host.name}`}
                      data-testid={`suite-client-configure-${host.hostId}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPickerOpen(false);
                        navigateApp(buildClientsPath(host.hostId));
                      }}
                      className={cn(
                        "absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-opacity",
                        "opacity-0 group-hover/host:opacity-100 group-focus-within/host:opacity-100 focus-visible:opacity-100",
                        "hover:bg-muted/60 hover:text-foreground",
                        "focus-visible:ring-2 focus-visible:ring-ring/45",
                      )}
                    >
                      <Settings2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Configure</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
          <div className="pt-0.5">
            <button
              type="button"
              onClick={() => {
                setPickerOpen(false);
                openClientsPage();
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span className="size-3.5 shrink-0" aria-hidden />
              <span>Manage clients…</span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );

  const showServersSection = Boolean(
    suite.projectId && (editable || suite.serverAttachment),
  );

  // The bar always renders (per the empty-state decision in the plan) so the
  // "Attach host" affordance is discoverable even on suites with no hosts.
  return (
    <div
      className={cn(
        containerVariant === "panel"
          ? "rounded-lg bg-card py-2.5 text-card-foreground"
          : "bg-transparent py-0 text-card-foreground",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-2 px-1 sm:px-2",
          containerVariant === "inline" && "w-full min-w-0 max-w-full",
        )}
      >
        {showServersSection ? (
          <div className="shrink-0">
            {editable && suite.projectId && onUpdateServerAttachment ? (
              <ServerAttachmentPicker
                projectId={suite.projectId}
                value={suite.serverAttachmentId ?? null}
                onChange={onUpdateServerAttachment}
              />
            ) : suite.serverAttachment ? (
              <span className="flex h-8 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground">
                <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                {suite.serverAttachment.name}
                <span className="text-[10px] text-muted-foreground">
                  · {suite.serverAttachment.serverIds.length} server
                  {suite.serverAttachment.serverIds.length === 1 ? "" : "s"}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}

        <div
          className={cn(
            "flex min-w-0 items-center",
            containerVariant === "inline" ? "min-w-0 flex-1" : "flex-1",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              containerVariant === "inline" ? "min-w-0 flex-1" : "flex-1",
            )}
          >
            {editable ? (
              clientPicker
            ) : attachments.length === 0 ? (
              <span className="shrink-0 text-[13px] font-normal text-muted-foreground">
                No clients attached
              </span>
            ) : (
              attachments.map((attachment) => {
                const label =
                  hostNameByAttachment.get(attachment.namedHostId) ??
                  projectHosts.find(
                    (h) => h.hostId === attachment.namedHostId,
                  )?.name ??
                  attachment.namedHostId;
                return (
                  <div
                    key={attachment.namedHostId}
                    className="flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-foreground"
                  >
                    <HostLogoMark label={label} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {label}
                    </span>
                  </div>
                );
              })
            )}
            {compareButton}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostLogoMark({ label }: { label: string }) {
  const logoSrc = resolveHostLogoByDisplayName(label);
  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        className="size-3.5 shrink-0 object-contain"
      />
    );
  }
  return (
    <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-muted" />
  );
}
