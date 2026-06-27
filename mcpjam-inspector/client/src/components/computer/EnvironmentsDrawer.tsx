import { useEffect, useMemo, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import {
  Check,
  Loader2,
  Plus,
  Trash2,
  Hammer,
  Users,
  ChevronLeft,
} from "lucide-react";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  usePromoteEnvironment,
  useSetComputerEnvironment,
  useStartEnvironmentBuild,
  useUpdateEnvironment,
  type EnvironmentView,
} from "@/hooks/useComputerEnvironments";
import { EnvironmentBuildBadge } from "./EnvironmentBuildBadge";

const NEW_ENVIRONMENT_TEMPLATE = `# Base must be an allowlisted official image (debian, ubuntu, node, python)
# pinned by @sha256 digest. Only FROM + RUN are supported today.
FROM debian:bookworm-slim@sha256:REPLACE_WITH_DIGEST
RUN echo "customize me"
`;

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    // Convex surfaces the thrown message; strip the noisy server prefix.
    return err.message.replace(/^\[.*?\]\s*/, "").slice(0, 400) || fallback;
  }
  return fallback;
}

/**
 * Manage the project's Computer environments and which one this computer boots
 * from. Opened from the Computer tab's "Change image" control. Builds stream
 * reactively via Convex queries, so no manual polling.
 */
export function EnvironmentsDrawer({
  open,
  onOpenChange,
  projectId,
  attachedEnvironmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  attachedEnvironmentId: string | null;
}) {
  const environments = useEnvironments(open ? projectId : null);
  const setComputerEnvironment = useSetComputerEnvironment();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = useMemo(
    () => environments?.find((e) => e.environmentId === selectedId) ?? null,
    [environments, selectedId]
  );

  // Detail / new-env editor lives below the list on mobile-narrow drawers.
  const showDetail = creating || selected !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>Environments</SheetTitle>
          <SheetDescription>
            A custom Docker image your computer boots from. Changing the image
            rebuilds the computer.
          </SheetDescription>
        </SheetHeader>

        {!showDetail ? (
          <EnvironmentList
            environments={environments}
            attachedEnvironmentId={attachedEnvironmentId}
            onSelect={(id) => {
              setCreating(false);
              setSelectedId(id);
            }}
            onNew={() => {
              setSelectedId(null);
              setCreating(true);
            }}
            onUseBase={() => void detachToBase()}
            attachToBaseDisabled={attachedEnvironmentId === null}
          />
        ) : creating ? (
          <NewEnvironmentForm
            projectId={projectId}
            onCancel={() => setCreating(false)}
            onCreated={(env) => {
              setCreating(false);
              setSelectedId(env.environmentId);
            }}
          />
        ) : selected ? (
          <EnvironmentDetail
            key={selected.environmentId}
            env={selected}
            projectId={projectId}
            isAttached={attachedEnvironmentId === selected.environmentId}
            onBack={() => setSelectedId(null)}
            onDeleted={() => setSelectedId(null)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );

  async function detachToBase() {
    try {
      await setComputerEnvironment({ projectId, environmentId: null });
      toast.success("Switched to the base image. Rebuilding your computer…");
    } catch (err) {
      toast.error(errMessage(err, "Could not switch to the base image."));
    }
  }
}

// ---------------------------------------------------------------------------

function EnvironmentList({
  environments,
  attachedEnvironmentId,
  onSelect,
  onNew,
  onUseBase,
  attachToBaseDisabled,
}: {
  environments: EnvironmentView[] | undefined;
  attachedEnvironmentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onUseBase: () => void;
  attachToBaseDisabled: boolean;
}) {
  if (environments === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading environments…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-2">
        {/* Base image row */}
        <button
          type="button"
          onClick={onUseBase}
          disabled={attachToBaseDisabled}
          className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:cursor-default disabled:opacity-100"
        >
          <span className="flex items-center gap-2">
            {attachedEnvironmentId === null ? (
              <Check className="h-4 w-4 text-primary" />
            ) : (
              <span className="h-4 w-4" />
            )}
            <span className="font-medium text-foreground">Base image</span>
            <span className="text-muted-foreground">
              Debian + Node + Python
            </span>
          </span>
          {attachedEnvironmentId !== null ? (
            <span className="text-xs text-muted-foreground">Use</span>
          ) : null}
        </button>

        {environments.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No custom environments yet — create one to customize your computer's
            image.
          </div>
        ) : (
          environments.map((env) => (
            <button
              key={env.environmentId}
              type="button"
              onClick={() => onSelect(env.environmentId)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50"
            >
              <span className="flex min-w-0 items-center gap-2">
                {attachedEnvironmentId === env.environmentId ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <span className="h-4 w-4 shrink-0" />
                )}
                <span className="truncate font-medium text-foreground">
                  {env.name}
                </span>
                {env.sharing === "project" ? (
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : null}
              </span>
              <EnvironmentBuildBadge build={env.currentBuild} />
            </button>
          ))
        )}
      </div>
      <div className="border-t p-2">
        <Button size="sm" variant="outline" className="w-full" onClick={onNew}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New environment
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NewEnvironmentForm({
  projectId,
  onCancel,
  onCreated,
}: {
  projectId: string;
  onCancel: () => void;
  onCreated: (env: EnvironmentView) => void;
}) {
  const createEnvironment = useCreateEnvironment();
  const [name, setName] = useState("");
  const [dockerfile, setDockerfile] = useState(NEW_ENVIRONMENT_TEMPLATE);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!name.trim()) {
      toast.error("Give the environment a name.");
      return;
    }
    setSaving(true);
    try {
      const env = await createEnvironment({
        projectId,
        name: name.trim(),
        dockerfile,
      });
      toast.success(`Created “${env.name}”. Build it to use it.`);
      onCreated(env);
    } catch (err) {
      toast.error(errMessage(err, "Could not create the environment."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <button
        type="button"
        onClick={onCancel}
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back
      </button>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Environment name"
        className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <DockerfileEditor value={dockerfile} onChange={setDockerfile} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void create()} disabled={saving}>
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Create
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EnvironmentDetail({
  env,
  projectId,
  isAttached,
  onBack,
  onDeleted,
}: {
  env: EnvironmentView;
  projectId: string;
  isAttached: boolean;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const updateEnvironment = useUpdateEnvironment();
  const startBuild = useStartEnvironmentBuild();
  const promote = usePromoteEnvironment();
  const deleteEnvironment = useDeleteEnvironment();
  const setComputerEnvironment = useSetComputerEnvironment();

  const [name, setName] = useState(env.name);
  const [dockerfile, setDockerfile] = useState(env.dockerfile);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Re-seed local buffers if the underlying env changes identity (the parent
  // remounts via `key`, but guard the reactive name/dockerfile too).
  useEffect(() => {
    setName(env.name);
    setDockerfile(env.dockerfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.environmentId]);

  const build = env.currentBuild;
  const isShared = env.sharing === "project";
  const dirty = name !== env.name || dockerfile !== env.dockerfile;
  const readyToAttach = build?.status === "ready" && !dirty;

  const save = async () => {
    setSaving(true);
    try {
      await updateEnvironment({
        environmentId: env.environmentId,
        ...(name !== env.name ? { name: name.trim() } : {}),
        ...(dockerfile !== env.dockerfile ? { dockerfile } : {}),
      });
      toast.success("Saved.");
    } catch (err) {
      toast.error(errMessage(err, "Could not save."));
    } finally {
      setSaving(false);
    }
  };

  const runBuild = async () => {
    if (dirty) {
      await save();
    }
    setBuilding(true);
    try {
      const res = await startBuild({ environmentId: env.environmentId });
      toast.success(res.reused ? "Reused an existing build." : "Build started.");
    } catch (err) {
      toast.error(errMessage(err, "Could not start the build."));
    } finally {
      setBuilding(false);
    }
  };

  const useOnComputer = async () => {
    setAttaching(true);
    try {
      await setComputerEnvironment({
        projectId,
        environmentId: env.environmentId,
      });
      toast.success(`Using “${env.name}”. Rebuilding your computer…`);
    } catch (err) {
      // Includes the by-design rejection when the builder/computer providers
      // are incompatible (e.g. stub build + e2b computer).
      toast.error(errMessage(err, "Could not use this environment."));
    } finally {
      setAttaching(false);
    }
  };

  const onPromote = async () => {
    try {
      await promote({ environmentId: env.environmentId });
      toast.success("Shared with the project.");
    } catch (err) {
      toast.error(
        errMessage(err, "Only project admins can share environments.")
      );
    }
  };

  const onDelete = async () => {
    try {
      await deleteEnvironment({ environmentId: env.environmentId });
      toast.success("Environment deleted.");
      onDeleted();
    } catch (err) {
      toast.error(
        errMessage(err, "Only project admins can delete shared environments.")
      );
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> All environments
        </button>
        <div className="flex items-center gap-2">
          <EnvironmentBuildBadge build={build} />
          {isAttached ? <Badge variant="outline">In use</Badge> : null}
        </div>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border bg-background px-3 py-2 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
      />

      <DockerfileEditor value={dockerfile} onChange={setDockerfile} />

      {build?.status === "failed" && build.error ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {build.error}
        </div>
      ) : null}
      {build?.logPreview ? (
        <pre className="max-h-32 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px] leading-snug text-muted-foreground">
          {build.logPreview}
        </pre>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {dirty ? (
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void runBuild()} disabled={building}>
          {building ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Hammer className="mr-1.5 h-3.5 w-3.5" />
          )}
          Build
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void useOnComputer()}
          disabled={!readyToAttach || attaching || isAttached}
          title={
            readyToAttach
              ? undefined
              : "Build the environment (and save changes) before using it"
          }
        >
          {attaching ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {isAttached ? "In use" : "Use on computer"}
        </Button>
      </div>

      <div className="mt-auto flex items-center justify-between border-t pt-3">
        {isShared ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" /> Shared with the project
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void onPromote()}>
            <Users className="mr-1.5 h-3.5 w-3.5" /> Share with project
          </Button>
        )}
        {confirmingDelete ? (
          <span className="inline-flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Delete?</span>
            <Button size="sm" variant="destructive" onClick={() => void onDelete()}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DockerfileEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className="min-h-[180px] flex-1 resize-y rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

