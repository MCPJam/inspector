import { useEffect } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import {
  MANAGE_AI_PROVIDERS,
  orgKeysRefusalNextStep,
} from "@/lib/org-keys-refusal";
import { toast } from "@/lib/toast";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";
import type { RunErrorBreakdown } from "./run-error-breakdown-model";

// Shared across mounts, for the lifetime of this app session.
const toastedRuns = new Set<string>();
const BREAKDOWN_TOAST_DURATION_MS = 20_000;

/** The fix when the organization has no usable provider for the model. */
function OrgProvidersFix({ projectId }: { projectId?: string }) {
  const appState = useOptionalSharedAppState();
  const organizationId = projectId
    ? (findProjectByAnyId(appState?.projects ?? {}, projectId)
        ?.organizationId ?? null)
    : null;
  const manageProviders = useOrgModelsHandoff(organizationId);
  return manageProviders ? (
    <Button
      variant="secondary"
      size="sm"
      className="mt-2"
      onClick={manageProviders}
    >
      {MANAGE_AI_PROVIDERS}
    </Button>
  ) : (
    <p className="mt-1 text-muted-foreground">
      {orgKeysRefusalNextStep("add_org_provider")}
    </p>
  );
}

export function RunErrorBreakdownDescription({
  breakdown,
  projectId,
}: {
  breakdown: RunErrorBreakdown;
  projectId?: string;
}) {
  return (
    <div
      className="mt-1 max-h-[min(16rem,40vh)] overflow-y-auto overscroll-contain"
      tabIndex={0}
      role="region"
      aria-label="Run errors"
      data-testid="run-error-breakdown"
    >
      <ul className="space-y-3">
        {breakdown.groups.map((group) => (
          <li
            key={group.cause}
            data-testid="run-error-group"
            data-cause={group.cause}
          >
            <div className="font-medium text-foreground">
              {group.title} ({group.count}{" "}
              {group.count === 1 ? "result" : "results"})
            </div>
            {group.errors.length > 0 && (
              <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                {group.errors.map((error) => (
                  <li
                    key={error.message}
                    className="whitespace-pre-wrap break-words"
                  >
                    {error.message}: {error.count}{" "}
                    {error.count === 1 ? "result" : "results"}
                  </li>
                ))}
              </ul>
            )}
            {group.cause === "orgProviders" && (
              <OrgProvidersFix projectId={projectId} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function useRunErrorBreakdownToast(
  runId: string,
  breakdown: RunErrorBreakdown | null,
  projectId?: string,
) {
  useEffect(() => {
    if (!breakdown || toastedRuns.has(runId)) return;
    toast.warning(breakdown.headline, {
      id: `run-error-breakdown-${runId}`,
      description: (
        <RunErrorBreakdownDescription
          breakdown={breakdown}
          projectId={projectId}
        />
      ),
      duration: BREAKDOWN_TOAST_DURATION_MS,
      closeButton: true,
    });
    toastedRuns.add(runId);
  }, [runId, breakdown, projectId]);
}
