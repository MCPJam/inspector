import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";

/**
 * The next step when the model someone wants isn't in the picker: "Add a
 * provider" for whoever may open the organization's AI providers, otherwise
 * a pointer to an admin.
 */
export function AddProviderStep({ onAdd }: { onAdd?: () => void }) {
  return onAdd ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 text-xs"
      onClick={() => onAdd()}
    >
      Add a provider
    </Button>
  ) : (
    <p className="text-[11px] font-medium text-foreground">
      Ask an organization admin to add one.
    </p>
  );
}

/** Add a provider through the active project's organization, if the viewer may. */
function ActiveOrgAddProvider({
  organizationId,
  leaveTo,
}: {
  organizationId: string;
  leaveTo: (handoff: () => void) => void;
}) {
  const handoff = useOrgModelsHandoff(organizationId);
  return handoff ? <AddProviderStep onAdd={() => leaveTo(handoff)} /> : null;
}

/**
 * A search that matched no model: says why it isn't listed and, when known,
 * what to do. A picker that passes no `onAdd` falls back to the active
 * project's organization, so every picker can offer "Add a provider" without
 * its callers threading a handoff through. Off the key policy, nothing known
 * about the viewer means no admin pointer either.
 */
export function ModelSearchEmpty({
  query,
  requireOrgKeys,
  onAdd,
  leaveTo,
}: {
  query: string;
  requireOrgKeys?: boolean;
  onAdd?: () => void;
  /** Closes the picker, then runs the handoff. */
  leaveTo: (handoff?: () => void) => void;
}) {
  const appState = useOptionalSharedAppState();
  const organizationId = findProjectByAnyId(
    appState?.projects ?? {},
    appState?.activeProjectId ?? null,
  )?.organizationId;
  return (
    <div className="space-y-2 px-3">
      <p>No models match "{query.trim()}".</p>
      <p className="text-[11px] text-muted-foreground">
        {requireOrgKeys
          ? "Only models from your organization's providers are listed."
          : "Only models MCPJam runs and models from your organization's providers are listed."}
      </p>
      {onAdd ? (
        <AddProviderStep onAdd={() => leaveTo(onAdd)} />
      ) : requireOrgKeys ? (
        <AddProviderStep />
      ) : organizationId ? (
        <ActiveOrgAddProvider
          organizationId={organizationId}
          leaveTo={leaveTo}
        />
      ) : null}
    </div>
  );
}

/** The footer under "Your providers" that opens the organization's AI providers. */
export function ManageOrgModelsLink({ onClick }: { onClick: () => void }) {
  return (
    <div className="border-t px-2 py-1.5">
      <button
        type="button"
        onClick={() => onClick()}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Manage organization models
        <ArrowUpRight className="size-3 shrink-0" />
      </button>
    </div>
  );
}
