/**
 * Swarm's "Where it runs" section.
 *
 * The two picker rows are the shared {@link EnvironmentComposer}; this wrapper
 * owns only what is swarm's: the section copy, the cloud-execution framing, the
 * empty states, and the draft action.
 */
import { useCallback } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { RequiredMark } from "@/components/shared/required-mark";
import { CloudRunBadge } from "@/components/computer/CloudRunBadge";
import { CloudUnreachableNotice } from "@/components/computer/CloudUnreachableNotice";
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
import {
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { MAX_ENVIRONMENTS_PER_JOURNEY } from "@/components/swarms/journey-environments";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useEphemeralCloudAvailable } from "@/hooks/useProjectComputer";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { saveTentativeCastle } from "@/lib/tentative-castle-drafts";
import { toast } from "@/lib/toast";

export function SwarmTargetComposer({
  projectId,
  environments,
  environmentsLoading,
  value,
  onChange,
  draftNameHint,
  disabled = false,
  serverBlock = null,
  required = false,
}: {
  projectId: string;
  environments: ProjectEnvironmentView[];
  environmentsLoading?: boolean;
  value: EnvironmentComposerState;
  onChange: (next: EnvironmentComposerState) => void;
  /** Used for draft naming. */
  draftNameHint?: string;
  disabled?: boolean;
  /**
   * Why the current selection can't back a cloud run, from
   * `describeCloudServerBlock`. The owning flow computes it because it also
   * gates its primary action on it; this only paints it, next to the pickers
   * that fix it.
   */
  serverBlock?: { message: string; detail: string } | null;
  /** Renders the required marker beside the label. The caller still owns gating. */
  required?: boolean;
}) {
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const ephemeralCloudAvailable = useEphemeralCloudAvailable();
  // `false` only from a real server answer — loading / fetch failure never
  // paints the warning. The image pill disables its own options on the same
  // signal; this only EXPLAINS the block, in swarm's terms.
  const sandboxCloudUnreachable =
    computersEnabled && ephemeralCloudAvailable === false;
  const composeMode = isComposeMode(value);
  const stackName = draftNameHint?.trim() || "Swarm setup";
  const hasLiveEnvironments = environments.some((e) => !e.archivedAt);

  const handleSaveDraft = useCallback(() => {
    const saved = saveTentativeCastle(projectId, {
      name: stackName,
      hostIds: value.stack.hostIds,
      serverAttachmentId: value.stack.serverAttachmentId,
      skillSelection: skillsEnabled ? value.stack.skillSelection : null,
      computerEnvironmentId: computersEnabled
        ? value.stack.computerEnvironmentId
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
    value.stack.computerEnvironmentId,
    value.stack.hostIds,
    value.stack.serverAttachmentId,
    value.stack.skillSelection,
  ]);

  return (
    <div className="space-y-3" data-testid="new-swarm-target-composer">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label>
            Where it runs
            {required ? <RequiredMark /> : null}
          </Label>
          {computersEnabled ? (
            <CloudRunBadge
              tooltip="Swarm sessions run their computer commands in disposable MCPJam cloud sandboxes — never on the machine running this inspector."
              data-testid="new-swarm-cloud-run-badge"
            />
          ) : null}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {environmentsEnabled
            ? "Start from an environment or build from clients and the shared stack below. Clients are the usual fan-out."
            : "Build from clients and the shared stack below. Clients are the usual fan-out."}
        </p>
      </div>

      {sandboxCloudUnreachable ? (
        <CloudUnreachableNotice
          data-testid="new-swarm-cloud-unreachable"
          message="Swarm computer commands need an MCPJam cloud sandbox, which this inspector can't run."
          detail="Runs without a computer can continue; sandbox-backed sessions would fail. Picking a new sandbox image is disabled — clear an existing one with Computer · default."
        />
      ) : null}

      {serverBlock ? (
        <CloudUnreachableNotice
          data-testid="new-swarm-server-unreachable"
          message={serverBlock.message}
          detail={serverBlock.detail}
        />
      ) : null}

      <EnvironmentComposer
        projectId={projectId}
        environments={environments}
        value={value}
        onChange={onChange}
        maxTargets={MAX_ENVIRONMENTS_PER_JOURNEY}
        disabled={disabled}
        testIdPrefix="new-swarm"
      />

      {environmentsEnabled && composeMode ? (
        <div className="flex flex-wrap items-center gap-2">
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

      {environmentsEnabled && environmentsLoading ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Loading environments…
        </p>
      ) : environmentsEnabled &&
        !hasLiveEnvironments &&
        value.stack.hostIds.length === 0 ? (
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
      ) : !environmentsEnabled && value.stack.hostIds.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Pick clients above to choose where this swarm runs.
        </p>
      ) : null}
    </div>
  );
}
