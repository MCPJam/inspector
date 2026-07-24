import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { HostPicker } from "@/components/hosts/HostPicker";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import { convexErrMessage } from "@/lib/convex-error";
import {
  isRevisionConflictError,
  useCreateProjectEnvironment,
  useUpdateProjectEnvironment,
  type ProjectEnvironmentSkillSelection,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { ProjectEnvironmentSkillsPicker } from "./ProjectEnvironmentSkillsPicker";

type EnvironmentDraft = {
  name: string;
  description: string;
  hostId: string | null;
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
};

function draftFromEnvironment(env: ProjectEnvironmentView): EnvironmentDraft {
  return {
    name: env.name,
    description: env.description ?? "",
    hostId: env.hostId,
    serverAttachmentId: env.serverAttachmentId ?? null,
    skillSelection: env.skillSelection ?? null,
  };
}

function sameSkillSelection(
  a: ProjectEnvironmentSkillSelection | null,
  b: ProjectEnvironmentSkillSelection | null
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.skillIds.length === b.skillIds.length &&
    a.skillIds.every((id, i) => id === b.skillIds[i])
  );
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
  onCreated,
  onCancelCreate,
}: {
  projectId: string;
  /** null ⇒ create mode. */
  environment: ProjectEnvironmentView | null;
  /** Admin-gated writes; members get a read-only form. */
  canManage: boolean;
  onCreated?: (env: ProjectEnvironmentView) => void;
  onCancelCreate?: () => void;
}) {
  const createEnvironment = useCreateProjectEnvironment();
  const updateEnvironment = useUpdateProjectEnvironment();

  const [draft, setDraft] = useState<EnvironmentDraft>(() =>
    environment
      ? draftFromEnvironment(environment)
      : {
          name: "",
          description: "",
          hostId: null,
          serverAttachmentId: null,
          skillSelection: null,
        }
  );
  // Captured at draft init/reset — the ONLY revision update may send.
  const [baseRevision, setBaseRevision] = useState<number | null>(
    environment?.revision ?? null
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
      !sameSkillSelection(
        draft.skillSelection,
        environment.skillSelection ?? null
      )
    : trimmedName.length > 0 ||
      trimmedDescription.length > 0 ||
      draft.hostId !== null ||
      draft.serverAttachmentId !== null ||
      draft.skillSelection !== null;

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
          }
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
          ...(draft.skillSelection
            ? { skillSelection: draft.skillSelection }
            : {}),
        });
        toast.success(`Created “${created.name}”.`);
        onCreated?.(created);
        return;
      }
      if (baseRevision === null) return;
      const updated = await updateEnvironment({
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
        ...(!sameSkillSelection(
          draft.skillSelection,
          environment.skillSelection ?? null
        )
          ? { skillSelection: draft.skillSelection }
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
          "This environment was changed by someone else — review the refreshed values before saving again."
        );
      } else {
        toast.error(
          convexErrMessage(
            err,
            environment
              ? "Could not save the environment."
              : "Could not create the environment."
          )
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
          Every environment runs on exactly one client. The client&apos;s own
          skills always apply on top of this environment&apos;s selection.
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
