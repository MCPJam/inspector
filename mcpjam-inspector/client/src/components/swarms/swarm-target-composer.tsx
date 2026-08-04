/**
 * Castle + lego strip for New Swarm Shared setup.
 *
 * Castle chip seeds the lego strip from a saved environment. Clients are the
 * primary fan-out; server group / skills / computer are shared stack slots.
 * Pure castle multi-select skips materialize; customized legos materialize
 * into real project environments before launch.
 */
import { useCallback, useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import { ChevronDown, Users } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { ProjectEnvironmentSkillsPicker } from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import { EnvironmentBuildBadge } from "@/components/computer/EnvironmentBuildBadge";
import { MAX_ENVIRONMENTS_PER_JOURNEY } from "@/components/swarms/journey-environments";
import {
  emptySwarmLegoStack,
  isSwarmComposeMode,
  type SwarmLegoStack,
  type SwarmTargetComposerState,
} from "@/components/swarms/swarm-target-types";
import { useHostList } from "@/hooks/useClients";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { saveTentativeCastle } from "@/lib/tentative-castle-drafts";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function legosFromEnvironment(env: ProjectEnvironmentView): SwarmLegoStack {
  return {
    hostIds: env.hostId ? [env.hostId] : [],
    serverAttachmentId: env.serverAttachmentId ?? null,
    skillSelection: env.skillSelection ?? null,
    computerEnvironmentId: env.computerEnvironmentId ?? null,
  };
}

function ClientMultiPill({
  projectId,
  value,
  onChange,
  max,
  disabled,
}: {
  projectId: string;
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  disabled?: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const [open, setOpen] = useState(false);

  const selected = value;
  const triggerLabel =
    selected.length === 0
      ? "No clients · pick some"
      : hosts.find((h) => h.hostId === selected[0])?.name ??
        selected[0].slice(0, 8);
  const extra = selected.length > 1 ? selected.length - 1 : 0;
  const logo =
    selected.length > 0
      ? resolveHostLogoByDisplayName(triggerLabel)
      : null;

  const toggle = (hostId: string, checked: boolean) => {
    if (checked) {
      if (selected.includes(hostId) || selected.length >= max) return;
      onChange([...selected, hostId]);
    } else {
      onChange(selected.filter((id) => id !== hostId));
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="new-swarm-clients-picker"
          aria-label="Clients"
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            selected.length === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          {logo ? (
            <img
              src={logo}
              alt=""
              className="size-3.5 shrink-0 rounded-sm object-contain"
            />
          ) : (
            <Users className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {extra > 0 ? (
            <span className="text-[10px] text-muted-foreground">+{extra}</span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start" sideOffset={4}>
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Clients · fan-out
        </div>
        {isLoading ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading clients…
          </p>
        ) : hosts.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No clients in this project yet.
          </p>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {hosts.map((host) => {
              const checked = selected.includes(host.hostId);
              const capBlocked = !checked && selected.length >= max;
              return (
                <Label
                  key={host.hostId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    (capBlocked || disabled) &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      toggle(host.hostId, next === true)
                    }
                    disabled={capBlocked || disabled}
                    aria-label={host.name}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {host.name}
                  </span>
                </Label>
              );
            })}
          </div>
        )}
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigateApp(routePaths.hosts);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          >
            Manage clients…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SwarmTargetComposer({
  projectId,
  environments,
  environmentsLoading,
  value,
  onChange,
  draftNameHint,
  onSaveAsEnvironments,
  savingEnvironments = false,
  disabled = false,
}: {
  projectId: string;
  environments: ProjectEnvironmentView[];
  environmentsLoading?: boolean;
  value: SwarmTargetComposerState;
  onChange: (next: SwarmTargetComposerState) => void;
  /** Used for draft / auto-env naming. */
  draftNameHint?: string;
  /** Persist legos as real environments now (materialize + select castles). */
  onSaveAsEnvironments?: () => void | Promise<void>;
  savingEnvironments?: boolean;
  disabled?: boolean;
}) {
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();
  const sandboxImages = useSandboxImages(computersEnabled ? projectId : null);
  const liveEnvironments = useMemo(
    () => environments.filter((e) => !e.archivedAt),
    [environments]
  );
  const composeMode = isSwarmComposeMode(value);
  const stackName = draftNameHint?.trim() || "Swarm setup";

  const patchLegos = useCallback(
    (patch: Partial<SwarmLegoStack>) => {
      onChange({
        ...value,
        customized: true,
        legos: { ...value.legos, ...patch },
      });
    },
    [onChange, value]
  );

  const handleCastleChange = useCallback(
    (nextIds: string[]) => {
      const ids = nextIds.slice(0, MAX_ENVIRONMENTS_PER_JOURNEY);
      // Seed from the most recently added castle when selection grows; when
      // the selection shrinks or clears, keep current legos unless empty.
      let seeded = value.legos;
      const added = ids.find((id) => !value.castleIds.includes(id));
      if (added) {
        const env = liveEnvironments.find((e) => e.environmentId === added);
        if (env) seeded = legosFromEnvironment(env);
      } else if (ids.length === 1) {
        const env = liveEnvironments.find((e) => e.environmentId === ids[0]);
        if (env) seeded = legosFromEnvironment(env);
      } else if (ids.length === 0 && !value.customized) {
        seeded = emptySwarmLegoStack();
      }
      onChange({
        castleIds: ids,
        legos: seeded,
        // Selecting castles resets customize — pure multi-castle path.
        customized: false,
      });
    },
    [liveEnvironments, onChange, value.castleIds, value.customized, value.legos]
  );

  const handleSaveDraft = useCallback(() => {
    const saved = saveTentativeCastle(projectId, {
      name: stackName,
      hostIds: value.legos.hostIds,
      serverAttachmentId: value.legos.serverAttachmentId,
      skillSelection: skillsEnabled ? value.legos.skillSelection : null,
      computerEnvironmentId: computersEnabled
        ? value.legos.computerEnvironmentId
        : null,
    });
    if (!saved) {
      toast.error("Could not save draft on this device.");
      return;
    }
    toast.success("Draft saved — open Environments to finish it.");
  }, [
    computersEnabled,
    projectId,
    skillsEnabled,
    stackName,
    value.legos.computerEnvironmentId,
    value.legos.hostIds,
    value.legos.serverAttachmentId,
    value.legos.skillSelection,
  ]);

  return (
    <div className="space-y-3" data-testid="new-swarm-target-composer">
      <div className="space-y-1">
        <Label>Where it runs</Label>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Start from an environment or build from clients, servers, skills, and
          computer. Clients are the usual fan-out.
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <EnvironmentPicker
          projectId={projectId}
          value={value.castleIds}
          onChange={handleCastleChange}
          multi
          max={MAX_ENVIRONMENTS_PER_JOURNEY}
          disabled={disabled}
          emptyLabel="No environments · pick some"
          triggerTestId="new-swarm-environments-picker"
          triggerAriaLabel="Environments"
        />
        {composeMode ? (
          <span
            className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            data-testid="new-swarm-target-custom-badge"
          >
            Custom
          </span>
        ) : null}
      </div>

      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-testid="new-swarm-lego-strip"
      >
        <ClientMultiPill
          projectId={projectId}
          value={value.legos.hostIds}
          onChange={(hostIds) => patchLegos({ hostIds })}
          max={MAX_ENVIRONMENTS_PER_JOURNEY}
          disabled={disabled}
        />
        <ServerGroupPicker
          projectId={projectId}
          value={value.legos.serverAttachmentId}
          onChange={(serverAttachmentId) =>
            patchLegos({ serverAttachmentId })
          }
          disabled={disabled}
          emptyTriggerLabel="Server group · client default"
          infoText="Optional shared server group for every client in this snap."
          onClearSelection={() => patchLegos({ serverAttachmentId: null })}
        />
        {skillsEnabled ? (
          <div className="min-w-[10rem] max-w-[16rem] flex-1 basis-[10rem]">
            <ProjectEnvironmentSkillsPicker
              projectId={projectId}
              value={value.legos.skillSelection}
              onChange={(skillSelection) => patchLegos({ skillSelection })}
              disabled={disabled}
            />
          </div>
        ) : null}
        {computersEnabled ? (
          <select
            data-testid="new-swarm-sandbox-image"
            aria-label="Sandbox image"
            value={value.legos.computerEnvironmentId ?? ""}
            disabled={disabled}
            onChange={(e) =>
              patchLegos({
                computerEnvironmentId: e.target.value || null,
              })
            }
            className="h-8 max-w-[200px] rounded-full border border-border/60 bg-muted/40 px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          >
            <option value="">Computer · default</option>
            {(sandboxImages ?? []).map((img) => {
              const ready = img.currentBuild?.status === "ready";
              const isDraft = img.sharing !== "project";
              return (
                <option
                  key={img.environmentId}
                  value={img.environmentId}
                  disabled={isDraft}
                >
                  {img.name}
                  {isDraft
                    ? " (draft)"
                    : ready
                      ? ""
                      : " (not built)"}
                </option>
              );
            })}
          </select>
        ) : null}
        {computersEnabled && value.legos.computerEnvironmentId ? (
          <EnvironmentBuildBadge
            build={
              (sandboxImages ?? []).find(
                (img) =>
                  img.environmentId === value.legos.computerEnvironmentId
              )?.currentBuild ?? null
            }
          />
        ) : null}
      </div>

      {composeMode ? (
        <div className="flex flex-wrap items-center gap-2">
          {onSaveAsEnvironments ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                disabled ||
                savingEnvironments ||
                value.legos.hostIds.length === 0
              }
              data-testid="new-swarm-save-as-environments"
              onClick={() => void onSaveAsEnvironments()}
            >
              {savingEnvironments ? "Saving…" : "Save as environment(s)"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            data-testid="new-swarm-save-draft"
            onClick={handleSaveDraft}
          >
            Save draft
          </Button>
        </div>
      ) : null}

      {environmentsLoading ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Loading environments…
        </p>
      ) : liveEnvironments.length === 0 && value.legos.hostIds.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          No environments yet — pick clients above to compose, or{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => navigateApp(routePaths.environments)}
          >
            open Environments
          </button>
          .
        </p>
      ) : null}
    </div>
  );
}
