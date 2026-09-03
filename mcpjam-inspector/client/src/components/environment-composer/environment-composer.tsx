/**
 * The environment composer: one strip that lets a surface say where a run
 * executes, either by picking saved environments or by composing a loose stack.
 *
 *  Environments — picking one SEEDS the stack from it, which is what makes
 *                 "same setup, different client" a one-click edit.
 *  Stack — clients (the fan-out axis) plus the shared slots a client runs under
 *          (server group, pinned skills, sandbox image).
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
import { useCallback, useMemo, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { ServerPicker } from "@/components/hosts/server-picker";
import { ClientsPill } from "@/components/environment-composer/clients-pill";
import { ModelsPill } from "@/components/environment-composer/models-pill";
import { SkillsPill } from "@/components/environment-composer/skills-pill";
import { SandboxImagePill } from "@/components/environment-composer/sandbox-image-pill";
import {
  composerStateFromEnvironments,
  composerTargetCount,
  emptyEnvironmentStack,
  emptyModelSelection,
  environmentsCarryModels,
  environmentsCarryPluginPins,
  environmentsExceedOneStack,
  modelChoiceCount,
  type EnvironmentComposerState,
  type EnvironmentStack,
  type TargetBudgetContext,
} from "@/components/environment-composer/environment-stack";
import { useHostList } from "@/hooks/useClients";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useModelMatrixCapability } from "@/hooks/use-model-matrix-capability";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { cn } from "@/lib/utils";

export type ComposerSlot =
  | "environments"
  | "clients"
  | "servers"
  | "skills"
  | "computers"
  | "models";

/** Default strip: no models slot. Evals opt in via `slots`. */
export const DEFAULT_COMPOSER_SLOTS: ComposerSlot[] = [
  "environments",
  "clients",
  "servers",
  "skills",
  "computers",
];

export const EVALS_COMPOSER_SLOTS: ComposerSlot[] = [
  ...DEFAULT_COMPOSER_SLOTS,
  "models",
];

export function EnvironmentComposer({
  projectId,
  environments,
  value,
  onChange,
  maxTargets = 10,
  disabled = false,
  testIdPrefix,
  inModal = false,
  environmentPickerFooter,
  className,
  slots = DEFAULT_COMPOSER_SLOTS,
  clientDefaultLabel,
  emptyServerLabel = "Server group · client default",
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
   * Which pills to offer. `models` stays out of the default and is opted
   * into by evals. Swarm / User Testing omit it so a model-bearing env
   * cannot silently shed its override.
   */
  slots?: readonly ComposerSlot[];
  /**
   * Inherited model id (or display name) for the Client-defaults row. When
   * omitted, the strip derives it from the selected clients: one shared
   * modelId becomes the pill label; mixed or missing models stay generic.
   */
  clientDefaultLabel?: string | null;
  /**
   * Empty-state label for the servers pill. The default is
   * the strip's own wording, where the group is genuinely optional; a surface
   * that makes it REQUIRED (evals create) must say so itself rather than
   * offering "client default" for a choice it will then block on.
   */
  emptyServerLabel?: string;
  /**
   * Prefix for this surface's test ids. The suffixes are historical (Swarms was
   * the first surface, hence "target"/"lego") — they are not composer concepts.
   */
  testIdPrefix?: string;
  /**
   * Render the popovers INLINE rather than portalled, for callers inside a Radix
   * Dialog. A portalled popover lands outside the dialog, where the modal
   * overlay's `pointer-events: none` swallows every click — so without this a
   * dialog's environment picker looks present and cannot be used. Same escape
   * hatch, same name, as `EnvironmentPicker` and `ServerPicker`.
   */
  inModal?: boolean;
  /** Forwarded into the environment picker's popover footer. */
  environmentPickerFooter?: ReactNode;
  className?: string;
}) {
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const { isAuthenticated } = useConvexAuth();
  const modelsOptedIn = slots.includes("models");
  const modelMatrix = useModelMatrixCapability(
    modelsOptedIn ? projectId : null
  );
  const modelsEnabled = modelsOptedIn && modelMatrix === true;
  const { hosts } = useHostList({
    isAuthenticated,
    projectId: modelsEnabled ? projectId : null,
  });
  // `slots` NARROWS, never widens: a slot must be both asked for by the caller
  // AND allowed by its flag. Omitting `slots` keeps DEFAULT_COMPOSER_SLOTS, so
  // every existing surface renders exactly the strip it rendered before.
  const environmentsSlotRequested = slots.includes("environments");
  const showEnvironmentsSlot = environmentsSlotRequested && environmentsEnabled;
  const showClientsSlot = slots.includes("clients");
  const showServersSlot = slots.includes("servers");
  const showSkillsSlot = slots.includes("skills") && skillsEnabled;
  const showComputersSlot = slots.includes("computers") && computersEnabled;

  const liveEnvironments = useMemo(
    () => environments.filter((e) => !e.archivedAt),
    [environments]
  );
  /**
   * The selection cannot be round-tripped through a stack, so slot edits are
   * blocked — the user can still change the SELECTION, which is the way out.
   * Two distinct reasons, each with its own hint below:
   *
   *  - `"pins"`: an environment pins plugin versions. The stack has no plugin
   *    slot, so the first edit would resolve rows without the pins and the run
   *    would silently shed them. Holds even for a single environment.
   *  - `"collapse"`: two environments run on the same client (the stack fans
   *    out over `hostIds`, so they'd resolve to ONE row and drop a target), or
   *    they disagree on a shared slot the project has enabled.
   *
   * Only while `customized` is false: once the stack is authoritative there is
   * no saved selection left to lose.
   */
  const stackEditBlock = useMemo<"pins" | "collapse" | "models" | null>(() => {
    if (value.customized || value.environmentIds.length === 0) return null;
    const selected = value.environmentIds
      .map((id) => liveEnvironments.find((e) => e.environmentId === id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (selected.length !== value.environmentIds.length) return null;
    if (environmentsCarryPluginPins(selected)) return "pins";
    if (!modelsEnabled && environmentsCarryModels(selected)) return "models";
    return environmentsExceedOneStack(selected, {
      skillsEnabled,
      computersEnabled,
      modelsEnabled,
    })
      ? "collapse"
      : null;
  }, [
    computersEnabled,
    liveEnvironments,
    modelsEnabled,
    skillsEnabled,
    value.customized,
    value.environmentIds,
  ]);
  const slotsDisabled = disabled || stackEditBlock !== null;
  const testId = (suffix: string) =>
    testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined;
  const choiceCount = modelChoiceCount(value.stack.modelSelection);
  const inheritedClientDefaultLabel = useMemo(() => {
    if (clientDefaultLabel) return clientDefaultLabel;
    const selected = new Set(value.stack.hostIds);
    const modelIds = [
      ...new Set(
        hosts
          .filter((host) => selected.has(host.hostId) && host.modelId)
          .map((host) => host.modelId)
      ),
    ];
    return modelIds.length === 1 ? modelIds[0] : null;
  }, [clientDefaultLabel, hosts, value.stack.hostIds]);
  const budget: TargetBudgetContext = {
    hostCount: value.stack.hostIds.length,
    choiceCount,
    maxTargets,
  };
  const targetCount = composerTargetCount(value);

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
      /** Ids → the rows this client can see. Unknown ids simply contribute
       *  nothing, which is what an ad-hoc or deleted id should do here. */
      const resolve = (list: string[]) =>
        list
          .map((id) => liveEnvironments.find((e) => e.environmentId === id))
          .filter((e): e is NonNullable<typeof e> => Boolean(e));
      const added = ids.find((id) => !value.environmentIds.includes(id));
      if (added) {
        // ADDING is the one move that re-seeds: the user is asking to run a
        // saved thing, so the strip should show what that thing is, and any
        // previous customization is what they just replaced.
        //
        // Seeded from the WHOLE selection, not just the added row. The stack's
        // fan-out axis IS `hostIds`, so seeding one client would mean that the
        // first later edit — which flips `customized` and hands resolution to
        // the stack — silently drops every other selected environment from the
        // run. `composerStateFromEnvironments` also empties any shared slot the
        // selection disagrees on, rather than imposing the newest row's on all.
        const selected = resolve(ids);
        onChange({
          environmentIds: ids,
          // `environmentIds` stays exactly what the picker said — the helper's
          // own id/customized output is for seeding from PERSISTED state and
          // would drop an already-attached ad-hoc id the picker can only detach.
          stack:
            selected.length > 0
              ? composerStateFromEnvironments(selected, {
                  skillsEnabled,
                  computersEnabled,
                  modelsEnabled,
                }).stack
              : value.stack,
          customized: false,
        });
        return;
      }
      // REMOVING has to do two things that pull against each other: drop what
      // was detached, and keep edits the user can still see in the strip.
      const remaining = resolve(ids);
      if (!value.customized) {
        // Untouched: the stack is a pure mirror of the selection, so mirror it.
        onChange({
          environmentIds: ids,
          stack:
            remaining.length > 0
              ? composerStateFromEnvironments(remaining, {
                  skillsEnabled,
                  computersEnabled,
                  modelsEnabled,
                }).stack
              : emptyEnvironmentStack(),
          customized: false,
        });
        return;
      }
      // Customized: keep the slot edits, but drop the clients that ONLY the
      // removed environments contributed. Preserving the whole stack would make
      // a detach do nothing — resolution goes through `hostIds`, so the removed
      // environment's client would still get a run — and re-seeding instead
      // would throw away the edits.
      const keptHosts = new Set(remaining.map((e) => e.hostId));
      const removedHosts = new Set(
        resolve(value.environmentIds.filter((id) => !ids.includes(id))).map(
          (e) => e.hostId
        )
      );
      onChange({
        environmentIds: ids,
        stack: {
          ...value.stack,
          hostIds: value.stack.hostIds.filter(
            (hostId) => !removedHosts.has(hostId) || keptHosts.has(hostId)
          ),
        },
        customized: true,
      });
    },
    [
      computersEnabled,
      liveEnvironments,
      maxTargets,
      modelsEnabled,
      onChange,
      skillsEnabled,
      value.environmentIds,
      value.customized,
      value.stack,
    ]
  );

  return (
    <div className={cn("space-y-3", className)}>
      <div
        className="flex min-w-0 flex-wrap items-center gap-2"
        data-testid={testId("lego-strip")}
      >
        {showEnvironmentsSlot ? (
          <EnvironmentPicker
            projectId={projectId}
            value={
              maxTargets === 1
                ? (value.environmentIds[0] ?? null)
                : value.environmentIds
            }
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
            inModal={inModal}
            footerSlot={environmentPickerFooter}
          />
        ) : null}
        {showClientsSlot ? (
          <ClientsPill
            projectId={projectId}
            value={value.stack.hostIds}
            onChange={(hostIds) => patchStack({ hostIds })}
            max={maxTargets}
            disabled={slotsDisabled}
            testId={testId("clients-picker")}
            inModal={inModal}
            budget={budget}
          />
        ) : null}
        {modelsEnabled ? (
          <ModelsPill
            projectId={projectId}
            // The stack's own contract says a state can genuinely arrive
            // without a selection (a draft persisted before the field existed),
            // and that a missed guard should read as "client defaults" rather
            // than throw mid-render. Every other reader here goes through
            // `modelChoiceCount`, which absorbs it; this was the one that
            // dereferenced the value directly.
            value={value.stack.modelSelection ?? emptyModelSelection()}
            onChange={(modelSelection) => patchStack({ modelSelection })}
            mode="multiple"
            disabled={slotsDisabled}
            testId={testId("models-picker")}
            inModal={inModal}
            budget={budget}
            clientDefaultLabel={inheritedClientDefaultLabel}
          />
        ) : null}
        {showServersSlot ? (
          <ServerPicker
            projectId={projectId}
            value={value.stack.serverAttachmentId}
            onChange={(serverAttachmentId) => patchStack({ serverAttachmentId })}
            disabled={slotsDisabled}
            emptyTriggerLabel={emptyServerLabel}
            triggerTestId={testId("servers-picker")}
            inModal={inModal}
          />
        ) : null}
        {showSkillsSlot ? (
          <SkillsPill
            projectId={projectId}
            value={value.stack.skillSelection}
            onChange={(skillSelection) => patchStack({ skillSelection })}
            disabled={slotsDisabled}
            testId={testId("skills-picker")}
            inModal={inModal}
          />
        ) : null}
        {showComputersSlot ? (
          <SandboxImagePill
            projectId={projectId}
            value={value.stack.computerEnvironmentId}
            onChange={(computerEnvironmentId) =>
              patchStack({ computerEnvironmentId })
            }
            disabled={slotsDisabled}
            testId={testId("sandbox-image")}
          />
        ) : null}
      </div>

      {/* Only when the caller asked for the environment slot: a surface that
          omitted it is already disabling everything and saying its own version
          of this, and naming that control would then point at something the
          user cannot reach. Gated on the REQUEST, not on `showEnvironmentsSlot`
          — folding in `environmentsEnabled` would leave a viewer without the
          environments flag staring at a fully greyed-out strip with nothing
          explaining why. */}
      {stackEditBlock && !disabled && environmentsSlotRequested ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid={testId("collapse-hint")}
        >
          {stackEditBlock === "pins"
            ? "This selection pins plugin versions, which this strip can't carry — editing the stack would run without them. Change the environment selection instead."
            : stackEditBlock === "models"
              ? "This selection pins a model override, which this strip can't carry — editing the stack would run the client default instead. Change the environment selection instead."
            : "These environments don't share one setup — they differ by client or by their server group, skills or image — so editing the stack would change what some of them run. Change the environment selection instead."}
        </p>
      ) : null}
      {modelsEnabled && !disabled ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid={testId("target-count")}
        >
          {targetCount} of {maxTargets} targets
        </p>
      ) : null}
    </div>
  );
}
