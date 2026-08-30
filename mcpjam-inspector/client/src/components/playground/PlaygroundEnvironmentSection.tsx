import { useEffect, useRef } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { ErrorCard } from "@/components/ui/error-card";
import {
  describeEnvironmentError,
  isNoServersError,
} from "@/lib/environment-error";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { pluralize } from "@/components/chat-v2/shared/chat-helpers";
import { PlaygroundPluginSelector } from "./PlaygroundPluginSelector";
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
    selectEnvironment,
    clearEnvironment,
    plugins,
    hasExplicitPluginOverride,
    resetPluginsToEnvironment,
    setPluginVersionEnabled,
    refreshPreview,
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
        className,
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
        <div
          className="flex min-w-0 flex-col gap-1"
          data-testid="playground-environment-error"
        >
          <ErrorCard
            error={describeEnvironmentError(previewError)}
            variant="inline"
            // Retry is pointless for a zero-servers failure — the resolve is
            // deterministic and would fail identically. Offer the thing that
            // actually fixes it instead. Note the preview FAILED, so there is
            // no resolved host to deep-link to; Servers is where the fix lives.
            {...(isNoServersError(previewError)
              ? {
                  action: {
                    label: "Open Servers",
                    onClick: () => navigateApp(routePaths.servers),
                  },
                }
              : { onRetry: refreshPreview })}
          />
          {/* The most common reason an environment refuses to resolve is a
              pinned plugin that is no longer runnable, and the failed preview
              cannot say which one. The probe reads the row's pins directly, so
              the answer survives the failure. */}
          <PlaygroundPluginSelector
            projectId={projectId}
            environmentId={environmentId}
            plugins={[]}
            hasExplicitOverride={false}
            disabled={disabled}
            onTogglePlugin={setPluginVersionEnabled}
            onResetPlugins={resetPluginsToEnvironment}
          />
        </div>
      ) : null}

      {isEnvironmentMode && preview ? (
        <div className="flex min-w-0 flex-col gap-1">
          {/* No summary line and no server chips here anymore: the composer's
              "+" menu owns the environment server rows and their per-turn
              toggles (including the Modified/reset affordance), and the Tools
              rail lists the resolved tools. Repeating them in the header only
              duplicated state three ways. What REMAINS here is what no other
              surface says: warnings about the resolved bundle, and the plugin
              chips with their preflight probe. */}

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

          {/* Plugin chips + preflight. Rendered inside the resolved block for
              the chips, but the selector itself also reports pinned versions
              that CANNOT run — the case where this block is absent entirely
              is handled by the same component below the error. */}
          <PlaygroundPluginSelector
            projectId={projectId}
            environmentId={environmentId}
            plugins={plugins}
            hasExplicitOverride={hasExplicitPluginOverride}
            disabled={disabled}
            onTogglePlugin={setPluginVersionEnabled}
            onResetPlugins={resetPluginsToEnvironment}
          />
        </div>
      ) : null}
    </div>
  );
}
