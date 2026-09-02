import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { HostPicker } from "@/components/hosts/HostPicker";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import { EnvironmentBuildBadge } from "@/components/computer/EnvironmentBuildBadge";
import { SandboxImagePicker } from "@/components/computer/SandboxImagePicker";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import { convexErrMessage } from "@/lib/convex-error";
import {
  isRevisionConflictError,
  useCreateProjectEnvironment,
  useUpdateProjectEnvironment,
  type ProjectEnvironmentSecretSelection,
  type ProjectEnvironmentSkillSelection,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { ProjectEnvironmentSkillsPicker } from "./ProjectEnvironmentSkillsPicker";
import { ProjectEnvironmentSecretsPicker } from "./ProjectEnvironmentSecretsPicker";
// Re-exported from the composer's shared helper rather than kept as a second
// copy: a dirty-check that missed version pins would silently discard a "hold
// this skill at v1" edit, and two implementations means one of them eventually
// does.
import {
  sameSecretSelection,
  sameSkillSelection,
} from "@/components/environment-composer/environment-stack";

type EnvironmentDraft = {
  name: string;
  description: string;
  hostId: string | null;
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
  /**
   * The environment's CREDENTIAL GRANT. Deliberately NOT flag-gated like skills
   * and sandbox images: there is no `secrets-enabled` flag, and a picker that
   * could vanish would be a picker whose stored grant could not be revoked from
   * the UI.
   */
  secretSelection: ProjectEnvironmentSecretSelection | null;
  computerEnvironmentId: string | null;
};

function draftFromEnvironment(env: ProjectEnvironmentView): EnvironmentDraft {
  return {
    // The editor only ever mounts for a NAMED row (ad-hoc rows get the
    // read-only detail view instead), so the fallback is unreachable in
    // practice — it exists so the draft type stays a plain `string` and the
    // dirty check below can compare without threading `undefined` through it.
    name: env.name ?? "",
    description: env.description ?? "",
    hostId: env.hostId,
    serverAttachmentId: env.serverAttachmentId ?? null,
    skillSelection: env.skillSelection ?? null,
    secretSelection: env.secretSelection ?? null,
    computerEnvironmentId: env.computerEnvironmentId ?? null,
  };
}

/**
 * Create/edit form for one project environment.
 *
 * expectedRevision pattern (the repo's optimistic-concurrency convention,
 * defined here): `baseRevision` is captured when the draft is
 * initialized/reset and THAT value is sent on update — never the newest
 * reactive row revision at submit time, which would let a stale draft
 * overwrite a concurrent edit. When reactivity observes a newer revision
 * while the form is dirty, the draft is marked stale; a mutation conflict
 * toasts, offers an explicit reload, and never auto-retries.
 */
export function ProjectEnvironmentEditor({
  projectId,
  environment,
  canManage,
  initialDraft,
  onCreated,
  onCancelCreate,
}: {
  projectId: string;
  /** null ⇒ create mode. */
  environment: ProjectEnvironmentView | null;
  /** Admin-gated writes; members get a read-only form. */
  canManage: boolean;
  /**
   * Create-mode-only pre-seed (the Connect "Save as environment" handoff).
   * Merged into the create initializer ONLY — deliberately NOT into the
   * projectId-reset effect, whose whole job is wiping cross-project host ids;
   * a seed surviving that reset would reintroduce exactly that hazard.
   * Ignored in edit mode.
   */
  initialDraft?: Partial<EnvironmentDraft>;
  onCreated?: (env: ProjectEnvironmentView) => void;
  onCancelCreate?: () => void;
}) {
  const createEnvironment = useCreateProjectEnvironment();
  const updateEnvironment = useUpdateProjectEnvironment();
  // Double gate: the editor already sits behind `project-environments-enabled`
  // (the route); the sandbox-image section additionally requires
  // `computers-enabled` and the skills section `skills-enabled` (both
  // fail-closed) — so environments can launch before hosted skills/computers.
  //
  // These flags are load-bearing for the WRITE path, not just visibility: while
  // a picker is hidden its field must be treated as if it weren't part of this
  // form at all — excluded from `dirty` and omitted from both payloads — so a
  // flag-off save can never set or clear a value configured through the
  // API/CLI. Draft divergence alone is NOT a sufficient guard, because a flag
  // can flip false after an edit and leave a diverged value behind a vanished
  // control.
  const computersEnabled = useComputersEnabled();
  const skillsEnabled = useSkillsEnabled();
  const sandboxImages = useSandboxImages(computersEnabled ? projectId : null);

  const [draft, setDraft] = useState<EnvironmentDraft>(() =>
    environment
      ? draftFromEnvironment(environment)
      : {
          name: "",
          description: "",
          hostId: null,
          serverAttachmentId: null,
          skillSelection: null,
          secretSelection: null,
          computerEnvironmentId: null,
          ...initialDraft,
        },
  );
  // Captured at draft init/reset — the ONLY revision update may send.
  const [baseRevision, setBaseRevision] = useState<number | null>(
    environment?.revision ?? null,
  );
  const [saving, setSaving] = useState(false);
  // Set on a rejected stale write; cleared only by an explicit reload.
  const [conflicted, setConflicted] = useState(false);

  const readOnly = !canManage;
  const trimmedName = draft.name.trim();
  const trimmedDescription = draft.description.trim();

  const dirty = environment
    ? trimmedName !== environment.name ||
      trimmedDescription !== (environment.description ?? "") ||
      draft.hostId !== environment.hostId ||
      draft.serverAttachmentId !== (environment.serverAttachmentId ?? null) ||
      // Flag-gated fields only count while their picker is rendered —
      // otherwise a flag flip would leave Save enabled for a field the
      // payload deliberately omits, i.e. a "Saved." that changes nothing but
      // bumps the revision.
      (skillsEnabled &&
        !sameSkillSelection(
          draft.skillSelection,
          environment.skillSelection ?? null,
        )) ||
      !sameSecretSelection(
        draft.secretSelection,
        environment.secretSelection ?? null,
      ) ||
      (computersEnabled &&
        draft.computerEnvironmentId !==
          (environment.computerEnvironmentId ?? null))
    : trimmedName.length > 0 ||
      trimmedDescription.length > 0 ||
      draft.hostId !== null ||
      draft.serverAttachmentId !== null ||
      (skillsEnabled && draft.skillSelection !== null) ||
      draft.secretSelection !== null ||
      (computersEnabled && draft.computerEnvironmentId !== null);

  // Reactivity observed someone else's edit while this draft diverged.
  const stale =
    environment !== null &&
    baseRevision !== null &&
    environment.revision !== baseRevision;

  const resetDraft = useCallback(() => {
    if (!environment) return;
    setDraft(draftFromEnvironment(environment));
    setBaseRevision(environment.revision);
    setConflicted(false);
  }, [environment]);

  // Project switched while the form is open: drop any draft that referenced the
  // previous project's host/server-group/skills so it can't be submitted to the
  // newly selected project. (Skips the initial mount — state already seeded.)
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setDraft(
      environment
        ? draftFromEnvironment(environment)
        : {
            name: "",
            description: "",
            hostId: null,
            serverAttachmentId: null,
            skillSelection: null,
            // Dropped along with the rest: a grant naming the previous
            // project's secrets would be rejected at save, and holding it
            // would let a form submit ids the new project cannot resolve.
            secretSelection: null,
            computerEnvironmentId: null,
          },
    );
    setBaseRevision(environment?.revision ?? null);
    setConflicted(false);
    // Reset is keyed on the project boundary only; `environment` changes are
    // handled by the list⇄detail remount and the explicit reload path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const save = async () => {
    if (!trimmedName) {
      toast.error("Give the environment a name.");
      return;
    }
    if (!draft.hostId) {
      toast.error("Pick a client for this environment.");
      return;
    }
    setSaving(true);
    try {
      if (!environment) {
        const created = await createEnvironment({
          projectId,
          name: trimmedName,
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
          hostId: draft.hostId,
          ...(draft.serverAttachmentId
            ? { serverAttachmentId: draft.serverAttachmentId }
            : {}),
          // Gated on the LIVE flags, not just the draft: PostHog can flip
          // `skills-enabled` / `computers-enabled` false after the user made a
          // pick, which unmounts the picker but leaves the draft value —
          // shipping it then would contradict the fail-closed contract.
          ...(skillsEnabled && draft.skillSelection
            ? { skillSelection: draft.skillSelection }
            : {}),
          ...(draft.secretSelection
            ? { secretSelection: draft.secretSelection }
            : {}),
          ...(computersEnabled && draft.computerEnvironmentId
            ? { computerEnvironmentId: draft.computerEnvironmentId }
            : {}),
        });
        toast.success(`Created “${created.name}”.`);
        onCreated?.(created);
        return;
      }
      if (baseRevision === null) return;
      const updated = await updateEnvironment({
        // Scopes the admin check and the row lookup on the backend; the update
        // is not addressable by environment id alone.
        projectId,
        environmentId: environment.environmentId,
        // The revision captured at draft init — NOT environment.revision,
        // which may have moved under a dirty draft.
        expectedRevision: baseRevision,
        ...(trimmedName !== environment.name ? { name: trimmedName } : {}),
        ...(trimmedDescription !== (environment.description ?? "")
          ? { description: trimmedDescription || null }
          : {}),
        ...(draft.hostId !== environment.hostId
          ? { hostId: draft.hostId }
          : {}),
        ...(draft.serverAttachmentId !==
        (environment.serverAttachmentId ?? null)
          ? { serverAttachmentId: draft.serverAttachmentId }
          : {}),
        // Flag-gated fields are included only when CHANGED **and** their
        // picker is currently rendered. Draft divergence alone is not enough:
        // if the flag flips false after an edit the picker unmounts while the
        // diverged draft value survives, and a "flag-off" save would then set
        // or clear the value — exactly what the fail-closed contract promises
        // it cannot do. Gating on the live flag makes a hidden picker always
        // omit the field (tri-state: omitted = unchanged, null = clear).
        ...(skillsEnabled &&
        !sameSkillSelection(
          draft.skillSelection,
          environment.skillSelection ?? null,
        )
          ? { skillSelection: draft.skillSelection }
          : {}),
        // NOT flag-gated, unlike the two fields around it — the picker is
        // always rendered, so the "hidden picker must omit the field" rule has
        // nothing to protect against here. Still tri-state: unchanged omits,
        // and clearing the last selection sends `null`, which REVOKES the
        // grant.
        ...(!sameSecretSelection(
          draft.secretSelection,
          environment.secretSelection ?? null,
        )
          ? { secretSelection: draft.secretSelection }
          : {}),
        ...(computersEnabled &&
        draft.computerEnvironmentId !==
          (environment.computerEnvironmentId ?? null)
          ? { computerEnvironmentId: draft.computerEnvironmentId }
          : {}),
      });
      setDraft(draftFromEnvironment(updated));
      setBaseRevision(updated.revision);
      setConflicted(false);
      toast.success("Saved.");
    } catch (err) {
      if (environment && isRevisionConflictError(err)) {
        // Never auto-retry a stale patch — surface it and let the user
        // review the refreshed values explicitly.
        setConflicted(true);
        toast.error(
          "This environment was changed by someone else — review the refreshed values before saving again.",
        );
      } else {
        toast.error(
          convexErrMessage(
            err,
            environment
              ? "Could not save the environment."
              : "Could not create the environment.",
          ),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {(stale || conflicted) && environment ? (
        <ConflictBanner
          conflicted={conflicted}
          dirty={dirty}
          onReload={resetDraft}
        />
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="project-environment-name" className="text-xs">
          Name
        </Label>
        <input
          id="project-environment-name"
          value={draft.name}
          disabled={readOnly}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="e.g. Staging on Claude"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-environment-description" className="text-xs">
          Description
        </Label>
        <textarea
          id="project-environment-description"
          value={draft.description}
          disabled={readOnly}
          onChange={(e) =>
            setDraft((d) => ({ ...d, description: e.target.value }))
          }
          placeholder="What this environment is for (optional)"
          rows={2}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Client</Label>
        <HostPicker
          projectId={projectId}
          value={draft.hostId}
          onChange={(hostId) => setDraft((d) => ({ ...d, hostId }))}
          location="project_environments"
          placeholder="Select a client"
          includeNone={false}
          disabled={readOnly}
        />
        <p className="text-[11px] text-muted-foreground">
          Every environment runs on exactly one client.
          {skillsEnabled
            ? " The client's own skills always apply on top of this environment's selection."
            : ""}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Server group</Label>
        <div className="flex items-center gap-2">
          <ServerGroupPicker
            projectId={projectId}
            value={draft.serverAttachmentId}
            onChange={(serverAttachmentId) =>
              setDraft((d) => ({ ...d, serverAttachmentId }))
            }
            disabled={readOnly}
            emptyTriggerLabel="Client default · pick a group"
            infoText="Optional: a named set of MCP servers this environment runs against. Without one, the client's own server picks apply."
            onClearSelection={() =>
              setDraft((d) => ({ ...d, serverAttachmentId: null }))
            }
          />
          {draft.serverAttachmentId && !readOnly ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() =>
                setDraft((d) => ({ ...d, serverAttachmentId: null }))
              }
            >
              <X className="mr-1 size-3" /> Clear
            </Button>
          ) : null}
        </div>
      </div>

      {skillsEnabled ? (
        <div className="space-y-1.5">
          <Label className="text-xs">Skills</Label>
          <ProjectEnvironmentSkillsPicker
            projectId={projectId}
            value={draft.skillSelection}
            onChange={(skillSelection) =>
              setDraft((d) => ({ ...d, skillSelection }))
            }
            disabled={readOnly}
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label className="text-xs">Secrets</Label>
        <ProjectEnvironmentSecretsPicker
          projectId={projectId}
          value={draft.secretSelection}
          onChange={(secretSelection) =>
            setDraft((d) => ({ ...d, secretSelection }))
          }
          disabled={readOnly}
        />
      </div>

      {computersEnabled ? (
        <div className="space-y-1.5">
          <Label
            htmlFor="project-environment-sandbox-image"
            className="text-xs"
          >
            Sandbox image
          </Label>
          <div className="flex items-center gap-2">
            {/* Same picker primitive as the Client and Server group rows above.
                Personal drafts are listed but not selectable — the backend
                rejects them (a draft would resolve for every member while being
                visible/mutable only to its owner) — and the annotated
                loading/deleted rows live in the shared component. */}
            <SandboxImagePicker
              variant="field"
              id="project-environment-sandbox-image"
              testId="project-environment-sandbox-image"
              images={sandboxImages}
              value={draft.computerEnvironmentId ?? null}
              disabled={readOnly}
              onChange={(computerEnvironmentId) =>
                setDraft((d) => ({ ...d, computerEnvironmentId }))
              }
              noPinLabel="None (default image)"
              draftNote=" (draft — promote to project first)"
            />
            {/* Badge only for a real selection — "None" has no build status
                (the badge component renders "Not built" for null/undefined). */}
            {draft.computerEnvironmentId ? (
              <EnvironmentBuildBadge
                build={
                  (sandboxImages ?? []).find(
                    (img) => img.environmentId === draft.computerEnvironmentId,
                  )?.currentBuild ?? null
                }
              />
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Applies to cloud runs in this environment: evals, swarms, and
            user-testing sessions each boot a fresh, isolated sandbox from this
            image. Cloud runs only — sandbox images never apply to the machine
            running this inspector. A not-built image fails at launch — build it
            first under Computer → Images.
          </p>
        </div>
      ) : null}

      {readOnly ? (
        <p className="text-[11px] text-muted-foreground">
          Only project admins can edit environments.
        </p>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {onCancelCreate ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onCancelCreate}
              disabled={saving}
            >
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={saving || (environment !== null && !dirty)}
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            {environment ? "Save" : "Create"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ConflictBanner({
  conflicted,
  dirty,
  onReload,
}: {
  conflicted: boolean;
  dirty: boolean;
  onReload: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-warning/50 bg-warning/10 p-3">
      <p className="flex items-start gap-2 text-xs text-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          {conflicted
            ? "Your save was rejected — this environment was changed by someone else."
            : "This environment was changed by someone else while you were editing."}{" "}
          Reloading discards your unsaved edits.
        </span>
      </p>
      {confirming && dirty ? (
        <span className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 text-xs"
            onClick={() => {
              setConfirming(false);
              onReload();
            }}
          >
            Discard &amp; reload
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setConfirming(false)}
          >
            Keep editing
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          onClick={() => {
            // A clean draft has nothing to lose — reload directly. A dirty
            // one requires the explicit discard confirmation.
            if (dirty) setConfirming(true);
            else onReload();
          }}
        >
          Load latest
        </Button>
      )}
    </div>
  );
}
