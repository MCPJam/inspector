import { useEffect, useRef } from "react";
import { AlertTriangle, Loader2, RotateCcw, X } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { pluralize } from "@/components/chat-v2/shared/chat-helpers";
import type { PlaygroundEnvironmentState } from "@/hooks/use-playground-environment";

/**
 * Playground "Environments" section (Project Environments — Phase 2.5).
 *
 * Rendered by {@link import("./PlaygroundHostPicker").PlaygroundHostPicker} and
 * by the Playground header's leading slot. Flag gating is the CALLER's job (see
 * `useProjectEnvironmentsEnabled`, fail-closed) — this component renders nothing
 * on its own when no environment is selected beyond the picker itself.
 *
 * Scope discipline, worth stating because the surrounding surface looks like it
 * contradicts it: model, temperature, system prompt and approval remain
 * EPHEMERAL Playground controls. Touching them here does not edit the
 * environment, and the server keeps `override-wins` for exactly those fields on
 * an environment turn. Editing an environment happens on `/environments`.
 *
 * The server list is rendered ID-FIRST from the preview's `{ serverId, name,
 * source }` entries and is never merged into the ordinary project-server list:
 * plugin-contributed servers are deliberately hidden from
 * `servers:getProjectServers`, so the name-keyed catalog cannot represent them.
 */
export function PlaygroundEnvironmentSection({
  projectId,
  environment,
  disabled = false,
  className,
}: {
  projectId: string | null;
  environment: PlaygroundEnvironmentState;
  disabled?: boolean;
  className?: string;
}) {
  const {
    isEnvironmentMode,
    environmentId,
    preview,
    isPreviewLoading,
    previewError,
    hasExplicitOverride,
    servers,
    selectEnvironment,
    clearEnvironment,
    resetServersToEnvironment,
    setServerEnabled,
  } = environment;

  // Telemetry: an environment resolving is also a host becoming the presented
  // client, so it reports through the same `client_selected` event as every
  // other host-choosing surface — with the `project_environments` location the
  // `HostPickerLocation` enum already reserves. Deduped on the host id so a
  // preview refresh doesn't re-emit.
  const lastTrackedHostIdRef = useRef<string | null>(null);
  const resolvedHostId = preview?.host.hostId ?? null;
  useEffect(() => {
    if (!isEnvironmentMode || !resolvedHostId) {
      // Leaving environment mode CLOSES the dedupe window. Without this,
      // select A → clear → select A again emits once, quietly undercounting
      // adoption of the very surface this event measures.
      if (!isEnvironmentMode) lastTrackedHostIdRef.current = null;
      return;
    }
    if (lastTrackedHostIdRef.current === resolvedHostId) return;
    lastTrackedHostIdRef.current = resolvedHostId;
    try {
      track("client_selected", {
        location: "project_environments",
        client_id: resolvedHostId,
      });
    } catch {
      // swallow — analytics must never block the selection
    }
  }, [isEnvironmentMode, resolvedHostId]);

  if (!projectId) return null;

  return (
    <div
      // Hard width cap, because the header slot that renders this is
      // `shrink-0`: without one, an environment with many server chips grows
      // the section until the Clear control and the header's trailing controls
      // are pushed out of the viewport. Capped here rather than in the header
      // so the section stays self-contained wherever it is slotted.
      className={cn(
        "flex w-full min-w-0 max-w-[26rem] flex-col gap-1.5",
        className
      )}
      data-testid="playground-environment-section"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <EnvironmentPicker
          projectId={projectId}
          value={environmentId}
          onChange={(next: string | null) => selectEnvironment(next)}
          multi={false}
          disabled={disabled}
          emptyLabel="Environment · none"
        />
        {isEnvironmentMode ? (
          <button
            type="button"
            onClick={clearEnvironment}
            disabled={disabled}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 px-2 text-[11px] text-muted-foreground hover:bg-muted/60 disabled:opacity-60"
            data-testid="playground-environment-clear"
          >
            <X className="size-3" aria-hidden />
            Clear
          </button>
        ) : null}
      </div>

      {isEnvironmentMode && isPreviewLoading && !preview ? (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Resolving environment…
        </div>
      ) : null}

      {isEnvironmentMode && previewError ? (
        <p
          className="text-[11px] text-destructive"
          data-testid="playground-environment-error"
        >
          {previewError}
        </p>
      ) : null}

      {isEnvironmentMode && preview ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              Environment: {preview.environment.name}
            </span>
            <span className="font-mono">
              rev {preview.environment.revision}
            </span>
            <span>·</span>
            <span data-testid="playground-environment-host">
              {preview.host.hostName ?? preview.host.hostId}
            </span>
            <span>·</span>
            <span data-testid="playground-environment-counts">
              {pluralize(preview.capabilities.serverCount, "server")} ·{" "}
              {pluralize(preview.capabilities.skillCount, "skill")} ·{" "}
              {pluralize(preview.capabilities.pluginCount, "plugin")}
            </span>
            {hasExplicitOverride ? (
              <span
                className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                data-testid="playground-environment-modified-badge"
              >
                Modified
              </span>
            ) : null}
            {hasExplicitOverride ? (
              <button
                type="button"
                onClick={resetServersToEnvironment}
                disabled={disabled}
                className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-primary underline-offset-4 hover:underline disabled:opacity-60"
                data-testid="playground-environment-reset"
              >
                <RotateCcw className="size-3" aria-hidden />
                Reset to environment
              </button>
            ) : null}
          </div>

          {/* Skills exist but this client's harness has no skill channel, so
              they would NOT be delivered. Said out loud rather than shown as a
              non-zero skill count the model never sees. */}
          {preview.capabilities.skillDelivery === "unsupported" &&
          preview.capabilities.skillCount > 0 ? (
            <p
              className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400"
              data-testid="playground-environment-skill-limitation"
            >
              <AlertTriangle className="mt-[1px] size-3 shrink-0" aria-hidden />
              <span>
                {preview.host.hostName ?? "This client"} can't consume skills —
                the {pluralize(preview.capabilities.skillCount, "skill")} in
                this environment won't reach the model on these turns.
              </span>
            </p>
          ) : null}

          {servers.length > 0 ? (
            <div
              // One scrolling row instead of an unbounded wrap: an environment
              // can resolve to a dozen servers (host picks + plugin-contributed
              // ones), and stacking them would push the chat surface down the
              // page on every render of the header.
              className="flex max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5"
              data-testid="playground-environment-servers"
            >
              {servers.map((server) => (
                <Label
                  key={server.serverId}
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5 text-[11px] font-normal",
                    server.enabled ? "bg-muted/40" : "opacity-55",
                    disabled && "cursor-not-allowed opacity-60"
                  )}
                  data-testid={`playground-environment-server-${server.serverId}`}
                >
                  <Checkbox
                    checked={server.enabled}
                    onCheckedChange={(next) =>
                      setServerEnabled(server.serverId, next === true)
                    }
                    disabled={disabled}
                    aria-label={server.name}
                  />
                  <span className="max-w-[160px] truncate">{server.name}</span>
                  {server.source === "plugin" ? (
                    <span className="rounded-full bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                      plugin
                    </span>
                  ) : null}
                </Label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
