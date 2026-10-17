import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

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
      onClick={onAdd}
    >
      Add a provider
    </Button>
  ) : (
    <p className="text-[11px] font-medium text-foreground">
      Ask an organization admin to add one.
    </p>
  );
}

/**
 * A search that matched no model: says why it isn't listed and, when known,
 * what to do. Off the key policy a missing `onAdd` says nothing about who the
 * viewer is, so no admin pointer is shown then.
 */
export function ModelSearchEmpty({
  query,
  requireOrgKeys,
  onAdd,
}: {
  query: string;
  requireOrgKeys?: boolean;
  onAdd?: () => void;
}) {
  return (
    <div className="space-y-2 px-3">
      <p>No models match "{query.trim()}".</p>
      <p className="text-[11px] text-muted-foreground">
        {requireOrgKeys
          ? "Only models from your organization's providers are listed."
          : "Only models MCPJam runs and models from your organization's providers are listed."}
      </p>
      {onAdd || requireOrgKeys ? <AddProviderStep onAdd={onAdd} /> : null}
    </div>
  );
}

/** The footer under "Your providers" that opens the organization's AI providers. */
export function ManageOrgModelsLink({ onClick }: { onClick: () => void }) {
  return (
    <div className="border-t px-2 py-1.5">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Manage organization models
        <ArrowUpRight className="size-3 shrink-0" />
      </button>
    </div>
  );
}
