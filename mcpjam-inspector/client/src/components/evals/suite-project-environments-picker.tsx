import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";
import {
  EnvironmentPicker,
  MAX_SUITE_ENVIRONMENTS,
} from "@/components/project-environments/environment-picker";

export { MAX_SUITE_ENVIRONMENTS };

/**
 * Ordered multi-select of project environments for a suite. Selection order IS
 * attach order (ordinal badges) — Run all fans out one run per environment in
 * this order.
 *
 * This is a thin PERSISTENCE wrapper: all selection UI (including the
 * archived/orphan detach-only rows) lives in the shared
 * {@link EnvironmentPicker}. This component only owns the commit through
 * `testSuites:setSuiteEnvironments`, where backend rejections (dupes, cap,
 * schedule-pin conflicts) surface verbatim.
 */
export function SuiteProjectEnvironmentsPicker({
  suiteId,
  projectId,
  environmentIds,
}: {
  suiteId: string;
  projectId: string;
  /** The suite's persisted attach-ordered environment ids. */
  environmentIds: string[] | undefined;
}) {
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as any
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[] | null;
  }) => Promise<unknown>;

  const [saving, setSaving] = useState(false);

  const commit = async (next: string[]) => {
    setSaving(true);
    try {
      await setSuiteEnvironments({
        suiteId,
        // `null` clears the field; an empty array is rejected by the backend.
        environmentIds: next.length > 0 ? next : null,
      });
    } catch (err) {
      // Includes the backend's schedule-pin conflict rejection — surface it
      // verbatim so the user sees which enabled schedule blocks the change.
      toast.error(convexErrMessage(err, "Failed to update environments"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EnvironmentPicker
      projectId={projectId}
      value={environmentIds ?? []}
      onChange={(next: string[]) => void commit(next)}
      multi
      max={MAX_SUITE_ENVIRONMENTS}
      busy={saving}
    />
  );
}
