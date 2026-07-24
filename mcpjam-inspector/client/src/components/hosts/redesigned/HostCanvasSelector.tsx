import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronsUpDown, Plus, Trash2 } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { toast } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import { useHostList, useHostMutations } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { buildHostsPath } from "@/lib/app-navigation";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { track } from "@/lib/analytics";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";
import { getCatalogHost } from "@mcpjam/sdk/host-compat";

/**
 * Client selector pinned to the top-left of the Connect host canvas.
 *
 * Replaces the header `HostOverlayBar` while the canvas is open (the header
 * instance hides itself — see `GlobalHostBar`). Layout settled in the #3269
 * review round: two pills pinned top-left so they stay accessible without
 * blocking the canvas —
 *   1. an "Add client" pill (left-most) carrying the quick-add template
 *      logos, and
 *   2. a switcher pill (to its right) that opens the full client list.
 * The add action lives only in the left pill; the switcher menu no longer
 * duplicates it. The menu opens downward, over empty canvas below the pills.
 */

const QUICK_ADD_TEMPLATES = ["claude", "chatgpt", "copilot"] as const;

const MCPJAM_HOST_NAME = "MCPJam";
const LAST_HOST_DELETE_REASON =
  "A project needs at least one client. Create another client first.";
const ANALYTICS_LOCATION = "host_canvas";

const PILL_CLASS =
  "flex items-center rounded-2xl border border-border/60 bg-card/95 p-1.5 shadow-lg shadow-black/[0.06] backdrop-blur-sm";

/**
 * Hosts don't persist which catalog template they came from, so the logo is
 * inferred from the display name. Unknown names fall back to the generic MCP
 * mark — never wrong, just anonymous.
 */
const LOGO_NAME_HINTS: Array<[RegExp, string]> = [
  [/mcpjam/i, "mcpjam"],
  [/claude[ -]?code/i, "claude-code"],
  [/claude/i, "claude"],
  [/chatgpt|openai/i, "chatgpt"],
  [/copilot/i, "copilot"],
  [/cursor/i, "cursor"],
  [/vs ?code/i, "vscode"],
  [/goose/i, "goose"],
  [/cline/i, "cline"],
  [/perplexity/i, "perplexity"],
  [/notion/i, "notion"],
  [/slack/i, "slack"],
  [/mistral/i, "mistral"],
];

const FALLBACK_LOGO = "/mcp.svg";

function inferLogoId(name: string): string | null {
  for (const [re, id] of LOGO_NAME_HINTS) {
    if (re.test(name)) return id;
  }
  return null;
}

interface HostCanvasSelectorProps {
  projectId: string;
  activeHostId: string;
}

export function HostCanvasSelector({
  projectId,
  activeHostId,
}: HostCanvasSelectorProps) {
  const navigate = useNavigate();
  const { isAuthenticated } = useConvexAuth();
  const catalogState = useHostCatalog();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { deleteHost } = useHostMutations();
  const [, setPreviewedHostId] = usePreviewedHostId(projectId);
  const [showCreate, setShowCreate] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<string | undefined>(
    undefined
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Same ordering the header pager uses: the seeded default first, then
  // alphabetical — keeps the `n / total` position chip stable across surfaces.
  const sortedHosts = useMemo(() => {
    return [...hosts].sort((a, b) => {
      const aIsDefault = a.name === MCPJAM_HOST_NAME;
      const bIsDefault = b.name === MCPJAM_HOST_NAME;
      if (aIsDefault && !bIsDefault) return -1;
      if (bIsDefault && !aIsDefault) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [hosts]);

  const activeIndex = useMemo(
    () => sortedHosts.findIndex((h) => h.hostId === activeHostId),
    [sortedHosts, activeHostId]
  );
  const active = activeIndex >= 0 ? sortedHosts[activeIndex] : null;

  const switchTo = (hostId: string) => {
    if (hostId === activeHostId) return;
    track("connect_host_overlay_swapped", {
      location: ANALYTICS_LOCATION,
      from: activeHostId,
      to: hostId,
      host_count: hosts.length,
    });
    setPreviewedHostId(hostId);
    // The URL is the source of truth for which host the canvas renders
    // (see App's hosts-route sync) — replace so switching doesn't pile
    // history entries.
    navigate(buildHostsPath(hostId), { replace: true });
  };

  const openCreateWithTemplate = (templateId?: string) => {
    setCreateTemplateId(templateId);
    setShowCreate(true);
    setMenuOpen(false);
    if (templateId) {
      track("connect_host_overlay_quick_added", {
        location: ANALYTICS_LOCATION,
        template_id: templateId,
      });
    }
  };

  const canDelete = sortedHosts.length > 1;

  const handleDelete = async (hostId: string) => {
    const host = hosts.find((h) => h.hostId === hostId);
    if (!host) return;
    setIsDeleting(true);
    try {
      await deleteHost({ hostId });
      toast.success(`Host "${host.name}" deleted`);
      // Deleting the host the canvas is rendering would leave it pointing
      // at a dead id until HostsTab's reconcile kicks the user back to the
      // browse view — jump to a surviving host instead.
      if (hostId === activeHostId) {
        const survivor = sortedHosts.find((h) => h.hostId !== hostId);
        if (survivor) switchTo(survivor.hostId);
      }
      // Telemetry is best-effort: a posthog throw must not bubble into the
      // shared catch and surface a delete-failure toast after the client
      // has already been removed.
      try {
        track("client_deleted", {
          location: ANALYTICS_LOCATION,
          client_id: hostId,
          force: false,
        });
      } catch {
        // swallow — analytics must not block the success path
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete host";
      if (msg.includes("consumer")) {
        toast.error(
          `${msg} — use force delete or remove dependent chatboxes/evals first`
        );
      } else {
        toast.error(msg);
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const logoFor = (name: string) => {
    const id = inferLogoId(name);
    return id ? getHostLogoSrc(id, themeMode) : FALLBACK_LOGO;
  };

  if (isLoading || !active) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-14 w-40 animate-pulse rounded-2xl border border-border/60 bg-card/80" />
        <div className="h-14 w-56 animate-pulse rounded-2xl border border-border/60 bg-card/80" />
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2"
      data-testid="host-canvas-selector"
    >
      {/* Add client — left-most. Carries the quick-add template logos so the
          add path stays a single control (the switcher menu no longer has its
          own add action). */}
      <div className={PILL_CLASS}>
        <button
          type="button"
          data-testid="host-canvas-add"
          onClick={() => {
            track("connect_host_overlay_add_clicked", {
              location: ANALYTICS_LOCATION,
              host_count: hosts.length,
            });
            openCreateWithTemplate(undefined);
          }}
          className={cn(
            "inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-primary transition-colors",
            "hover:bg-primary/10",
            "focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
          )}
        >
          <Plus className="size-4" />
          Add client
        </button>
        <span
          className="ml-0.5 flex shrink-0 items-center gap-0.5 pr-1"
          data-testid="host-canvas-quick-add"
        >
          {QUICK_ADD_TEMPLATES.map((id) => {
            const catalogHost =
              catalogState.status === "live"
                ? getCatalogHost(catalogState.catalog, id)
                : undefined;
            const label = catalogHost?.label ?? id;
            return (
              <button
                key={id}
                type="button"
                aria-label={`Add ${label} client`}
                title={`Add ${label}`}
                data-testid={`host-canvas-quick-add-${id}`}
                onClick={() => openCreateWithTemplate(id)}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-md transition-colors",
                  "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                )}
              >
                <img
                  src={getHostLogoSrc(id, themeMode)}
                  alt=""
                  className="size-4 object-contain"
                />
              </button>
            );
          })}
        </span>
      </div>

      {/* Switcher — to the right of Add client. Click to see all clients and
          switch between them; per-client delete lives on hover. */}
      <div className={PILL_CLASS}>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Client used for preview"
              data-testid="host-canvas-current"
              className={cn(
                "flex h-11 items-center gap-2.5 rounded-xl pr-2.5 pl-3.5 outline-none transition-colors",
                "hover:bg-muted/50 data-[state=open]:bg-muted/50",
                "focus-visible:ring-2 focus-visible:ring-ring/45"
              )}
            >
              <img
                src={logoFor(active.name)}
                alt=""
                className="size-5 shrink-0 object-contain"
              />
              <span className="max-w-[16rem] truncate text-[15px] font-semibold">
                {active.name}
              </span>
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                {activeIndex + 1} / {sortedHosts.length}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          {/* Opens downward, over the empty canvas below the top-left pills. */}
          <DropdownMenuContent
            side="bottom"
            align="start"
            sideOffset={10}
            className="min-w-[15rem]"
          >
            <DropdownMenuRadioGroup
              value={activeHostId}
              onValueChange={switchTo}
            >
              {sortedHosts.map((host) => (
                <DropdownMenuRadioItem
                  key={host.hostId}
                  value={host.hostId}
                  className="group gap-2.5 py-2 pr-1.5"
                >
                  <img
                    src={logoFor(host.name)}
                    alt=""
                    className="size-4 shrink-0 object-contain"
                  />
                  <span className="flex-1 truncate">{host.name}</span>
                  <span className="ml-2 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-[highlighted]:opacity-100">
                    <button
                      type="button"
                      aria-label={`Delete ${host.name}`}
                      data-testid={`host-canvas-delete-${host.hostId}`}
                      disabled={isDeleting || !canDelete}
                      title={!canDelete ? LAST_HOST_DELETE_REASON : undefined}
                      className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleDelete(host.hostId);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CreateHostDialog
        isOpen={showCreate}
        onClose={() => {
          setShowCreate(false);
          setCreateTemplateId(undefined);
        }}
        projectId={projectId}
        initialTemplateId={createTemplateId}
        onCreated={(hostId) => {
          track("connect_host_overlay_saved_as_new", {
            location: ANALYTICS_LOCATION,
            host_id: hostId,
          });
          switchTo(hostId);
        }}
      />
    </div>
  );
}
