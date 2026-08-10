/**
 * The environment composer: two rows that let a surface say where a run
 * executes, either by picking saved environments or by composing a loose stack.
 *
 *  Row 1 — saved environments. Picking one SEEDS row 2 from it, which is what
 *          makes "same setup, different client" a one-click edit.
 *  Row 2 — the stack: clients (the fan-out axis) plus the shared slots a client
 *          runs under (server group, pinned skills, sandbox image).
 *
 * PURE PRESENTATION, like the {@link EnvironmentPicker} it sits on top of: it
 * owns no persistence and no resolution. The caller holds the state and decides
 * what committing means — a Convex write per edit for a saved eval suite,
 * nothing at all until launch for a swarm draft. That split is what lets one
 * component serve a commit-on-every-toggle surface and an ephemeral one.
 *
 * Surface-specific chrome is deliberately NOT here: section copy, empty states,
 * draft actions, compare buttons. Wrap it and add those.
 *
 * `environments` is injected rather than queried so a caller can overlay rows it
 * just created (Swarms does, while the live query catches up) and so tests don't
 * need a Convex provider.
 */
import { useCallback, useMemo } from "react";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import { ClientsPill } from "@/components/environment-composer/clients-pill";
import { SkillsPill } from "@/components/environment-composer/skills-pill";
import { SandboxImagePill } from "@/components/environment-composer/sandbox-image-pill";
import {
  emptyEnvironmentStack,
  isComposeMode,
  stackFromEnvironment,
  type EnvironmentComposerState,
  type EnvironmentStack,
} from "@/components/environment-composer/environment-stack";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { cn } from "@/lib/utils";

export function EnvironmentComposer({
  projectId,
  environments,
  value,
  onChange,
  maxTargets = 10,
  disabled = false,
  testIdPrefix,
  className,
}: {
  projectId: string;
  /** Selectable saved environments. Archived rows are filtered out here. */
  environments: ProjectEnvironmentView[];
  value: EnvironmentComposerState;
  onChange: (next: EnvironmentComposerState) => void;
  /** Fan-out cap. `1` makes both rows single-select. */
  maxTargets?: number;
  disabled?: boolean;
  /**
   * Prefix for this surface's test ids. The suffixes are historical (Swarms was
   * the first surface, hence "target"/"lego") — they are not composer concepts.
   */
  testIdPrefix?: string;
  className?: string;
}) {
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();
  const environmentsEnabled = useProjectEnvironmentsEnabled();

  const liveEnvironments = useMemo(
    () => environments.filter((e) => !e.archivedAt),
    [environments]
  );
  const composeMode = isComposeMode(value);
  const testId = (suffix: string) =>
    testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined;

  const patchStack = useCallback(
    (patch: Partial<EnvironmentStack>) => {
      onChange({
        ...value,
        customized: true,
        stack: { ...value.stack, ...patch },
      });
    },
    [onChange, value]
  );

  const handleEnvironmentsChange = useCallback(
    (nextIds: string[]) => {
      const ids = nextIds.slice(0, maxTargets);
      const added = ids.find((id) => !value.environmentIds.includes(id));
      if (added) {
        // ADDING is the one move that re-seeds: the user is asking to run a
        // saved thing, so the strip should show what that thing is, and any
        // previous customization is what they just replaced.
        const env = liveEnvironments.find((e) => e.environmentId === added);
        onChange({
          environmentIds: ids,
          stack: env ? stackFromEnvironment(env) : value.stack,
          customized: false,
        });
        return;
      }
      // REMOVING keeps both the stack and `customized`. Re-seeding here would
      // discard edits the user can still see in the strip, and clearing
      // `customized` would silently flip an edited stack back onto the
      // saved-environment path — committing the saved ids and dropping every
      // edit, which is the worst of the three outcomes because it looks like it
      // worked.
      onChange({
        environmentIds: ids,
        stack:
          ids.length === 0 && !value.customized
            ? emptyEnvironmentStack()
            : value.stack,
        customized: value.customized,
      });
    },
    [
      liveEnvironments,
      maxTargets,
      onChange,
      value.environmentIds,
      value.customized,
      value.stack,
    ]
  );

  return (
    <div className={cn("space-y-3", className)}>
      {environmentsEnabled ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <EnvironmentPicker
            projectId={projectId}
            value={maxTargets === 1 ? (value.environmentIds[0] ?? null) : value.environmentIds}
            onChange={(next: string | string[] | null) =>
              handleEnvironmentsChange(
                Array.isArray(next) ? next : next ? [next] : []
              )
            }
            multi={maxTargets > 1}
            max={maxTargets}
            disabled={disabled}
            emptyLabel={
              maxTargets === 1
                ? "Select an environment"
                : "No environments · pick some"
            }
            triggerTestId={testId("environments-picker")}
            triggerAriaLabel="Environments"
          />
          {composeMode ? (
            <span
              className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              data-testid={testId("target-custom-badge")}
            >
              Custom
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-testid={testId("lego-strip")}
      >
        <ClientsPill
          projectId={projectId}
          value={value.stack.hostIds}
          onChange={(hostIds) => patchStack({ hostIds })}
          max={maxTargets}
          disabled={disabled}
          testId={testId("clients-picker")}
        />
        <ServerGroupPicker
          projectId={projectId}
          value={value.stack.serverAttachmentId}
          onChange={(serverAttachmentId) => patchStack({ serverAttachmentId })}
          disabled={disabled}
          emptyTriggerLabel="Server group · client default"
          infoText="Optional shared server group for every client in this setup."
          onClearSelection={() => patchStack({ serverAttachmentId: null })}
        />
        {skillsEnabled ? (
          <SkillsPill
            projectId={projectId}
            value={value.stack.skillSelection}
            onChange={(skillSelection) => patchStack({ skillSelection })}
            disabled={disabled}
            testId={testId("skills-picker")}
          />
        ) : null}
        {computersEnabled ? (
          <SandboxImagePill
            projectId={projectId}
            value={value.stack.computerEnvironmentId}
            onChange={(computerEnvironmentId) =>
              patchStack({ computerEnvironmentId })
            }
            disabled={disabled}
            testId={testId("sandbox-image")}
          />
        ) : null}
      </div>
    </div>
  );
}
