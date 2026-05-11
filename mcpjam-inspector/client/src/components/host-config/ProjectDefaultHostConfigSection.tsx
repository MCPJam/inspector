import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { HostConfigEditor } from "./HostConfigEditor";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import type { ServerWithName } from "@/hooks/use-app-state";

interface ProjectDefaultHostConfigSectionProps {
  /** Convex project id (the v2 owner). May be null for guest/local projects. */
  convexProjectId: string | null;
  /**
   * Map of server id → server entity for this project. Forwarded to the
   * editor's `availableServers` prop so users can include project servers
   * in the seed config. Keys are server ids; values carry the display name.
   */
  projectServers: Record<string, ServerWithName>;
  /**
   * When false, the editor renders read-only. Project Settings already
   * gates editing on `canManageMembers`; we mirror that here.
   */
  canManage: boolean;
}

/**
 * Project default HostConfig editor.
 *
 * The project default is a creation-time **seed** for new chatboxes,
 * eval suites, and direct chat tabs. Editing it does NOT propagate to
 * existing chatboxes or eval suites — they own their own hostConfig
 * rows. The Connection Settings tab edits a connection-only subset of
 * this same row through the legacy `updateProjectClientConfig`
 * compatibility wrapper.
 */
export function ProjectDefaultHostConfigSection({
  convexProjectId,
  projectServers,
  canManage,
}: ProjectDefaultHostConfigSectionProps) {
  const dto = useQuery(
    "hostConfigsV2:getProjectDefault" as any,
    convexProjectId ? ({ projectId: convexProjectId } as any) : "skip",
  ) as HostConfigDtoV2 | null | undefined;

  const setProjectDefault = useMutation(
    "hostConfigsV2:setProjectDefault" as any,
  ) as unknown as (args: {
    projectId: string;
    input: HostConfigInputV2;
  }) => Promise<string>;

  // Live editor state. `baseline` tracks what we last loaded/saved so we
  // can compute dirty state and reset cleanly. The dto round-trip runs
  // through `hostConfigDtoToInput` which deep-clones JSON record fields
  // — see comments in lib/host-config-v2.ts.
  const [value, setValue] = useState<HostConfigInputV2 | null>(null);
  const [baseline, setBaseline] = useState<HostConfigInputV2 | null>(null);
  const [hasJsonError, setHasJsonError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Hydrate when the dto loads or changes server-side. Don't stomp
  // in-progress edits: only sync `value` when there's no dirty state
  // (mirrors the suite editor's effect dep pattern).
  useEffect(() => {
    if (dto === undefined) return; // still loading
    const next = dto ? hostConfigDtoToInput(dto) : emptyHostConfigInputV2();
    setBaseline(next);
    setValue((current) => {
      if (current && baseline && !hostConfigInputsEqual(current, baseline)) {
        // User has unsaved edits; leave them alone. Reactive query
        // refresh will retry next time the user resets or saves.
        return current;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto]);

  const availableServers = useMemo(
    () =>
      Object.entries(projectServers).map(([id, srv]) => ({
        id,
        name: srv.name ?? id,
      })),
    [projectServers],
  );

  if (!convexProjectId) {
    return null;
  }

  if (value === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading default config…
      </div>
    );
  }

  const isDirty = baseline ? !hostConfigInputsEqual(value, baseline) : true;
  const canSave = canManage && isDirty && !hasJsonError && !isSaving;

  const handleReset = () => {
    if (baseline) setValue(baseline);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await setProjectDefault({ projectId: convexProjectId, input: value });
      setBaseline(value);
      toast.success("Project default config saved");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save project default",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">
          Default Host Config
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Seed for new chatboxes, eval suites, and direct chat tabs. Editing
          this does not change existing chatboxes or suites.
        </p>
      </div>

      <div className="rounded-xl border bg-card/60 p-4">
        <HostConfigEditor
          value={value}
          onChange={canManage ? setValue : () => {}}
          owner="project-default"
          availableServers={availableServers}
          onValidityChange={setHasJsonError}
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={!isDirty || isSaving}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={!canSave}
        >
          {isSaving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save default
        </Button>
      </div>
    </section>
  );
}
