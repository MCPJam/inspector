import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type {
  OrgModelProvider,
  UpsertOrgProviderArgs,
} from "@/hooks/use-org-model-config";
import { hostedModelDefinitionsFromSnapshot } from "@/shared/types";
import {
  GatewayCapabilityOverrides,
  GatewayModelMapping,
} from "./GatewayModelTable";
import {
  GatewayConnectionFields,
  GatewayRuntimeField,
  GatewayTestAlert,
} from "./GatewayFormParts";
import { GatewayApiList, GatewayWorksWithList } from "./GatewayReadiness";
import { suggestedGatewayName } from "./gateway-test-outcome";
import { gatewayWorksWith } from "./gateway-works-with";
import { useGatewayDraft } from "./use-gateway-draft";

/** The slug a new connection is saved under. */
const providerKeyFor = (name: string) =>
  `custom:${name.trim().toLowerCase().replace(/\s+/g, "-")}`;

/**
 * Add or edit a custom provider: the base URL and key, a Test that fills in
 * the rest (name, APIs, models and their mappings), where calls come from,
 * and what the provider will work with, before it is saved.
 */
export function GatewayDialog({
  open,
  onOpenChange,
  organizationId,
  editProvider,
  existingProviderKeys,
  requireOrgKeys,
  isSaving,
  onSave,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  editProvider: OrgModelProvider | null;
  existingProviderKeys: readonly string[];
  requireOrgKeys: boolean;
  isSaving: boolean;
  onSave: (args: UpsertOrgProviderArgs) => Promise<void>;
  onCancel: () => void;
}) {
  const draft = useGatewayDraft({
    open,
    onOpenChange,
    organizationId,
    editProvider,
    isSaving,
  });
  const catalogIds = useMemo(
    () => hostedModelDefinitionsFromSnapshot().map((model) => String(model.id)),
    [],
  );
  /** The admin's name for a new provider; null keeps the one from the host. */
  const [renamed, setRenamed] = useState<string | null>(null);
  useEffect(() => {
    if (open) setRenamed(null);
  }, [open]);

  const { baseUrl, runtime, apis, models, keyProblem, outcome } = draft;
  const trimmedName = (
    editProvider
      ? editProvider.displayName ||
        editProvider.providerKey.replace(/^custom:/, "")
      : (renamed ?? suggestedGatewayName(baseUrl))
  ).trim();
  const showDetails = !!editProvider || draft.passed;
  const nameProblem = /[/:]/.test(trimmedName)
    ? "Use a name without slashes or colons."
    : !editProvider &&
        existingProviderKeys.includes(providerKeyFor(trimmedName))
      ? `A custom provider named "${trimmedName}" already exists. Choose another name.`
      : null;
  const canSave =
    showDetails &&
    !!trimmedName &&
    !nameProblem &&
    !!baseUrl.trim() &&
    !keyProblem &&
    apis.length > 0 &&
    models.length > 0;
  const worksWith = gatewayWorksWith({
    apis,
    runtimeLocation: runtime,
    models,
    requireOrgKeys,
  });

  const save = () =>
    void onSave({
      providerKey: editProvider?.providerKey ?? providerKeyFor(trimmedName),
      displayName: trimmedName,
      ...draft.connection,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-left">
            {editProvider
              ? `Edit ${trimmedName || "provider"}`
              : "Add custom provider"}
          </DialogTitle>
          <DialogDescription className="text-left">
            Enter the provider's base URL and key, then test it. The test fills
            in the rest.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void draft.runTest();
          }}
        >
          <GatewayConnectionFields
            draft={draft}
            hasSecret={!!editProvider?.hasSecret}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!baseUrl.trim() || draft.testing}
          >
            {draft.testing ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : null}
            {draft.testing ? "Testing..." : "Test"}
          </Button>
        </form>

        {outcome ? (
          <GatewayTestAlert
            outcome={outcome}
            onUseInspector={draft.testFromInspector}
          />
        ) : null}

        {showDetails ? (
          // min-w-0 keeps long model names inside the dialog's grid.
          <div className="min-w-0 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="gateway-name">Name</Label>
              <Input
                id="gateway-name"
                value={renamed ?? trimmedName}
                onChange={(event) => setRenamed(event.target.value)}
                disabled={!!editProvider}
                aria-invalid={!!nameProblem}
              />
              {nameProblem ? (
                <p className="text-sm text-destructive">{nameProblem}</p>
              ) : null}
            </div>
            <GatewayRuntimeField value={runtime} onChange={draft.setRuntime} />
            <div className="space-y-2">
              <GatewayApiList
                selected={apis}
                results={draft.results}
                onChange={draft.setApis}
              />
              {apis.length === 0 ? (
                <p className="text-sm text-destructive">
                  Choose at least one API the provider serves.
                </p>
              ) : null}
            </div>
            <GatewayWorksWithList rows={worksWith} />
            <GatewayModelMapping
              models={models}
              catalogIds={catalogIds}
              onChange={draft.setModels}
            />
            <section
              aria-labelledby="gateway-capabilities"
              className="space-y-2"
            >
              <h3 id="gateway-capabilities" className="text-sm font-medium">
                Capabilities
              </h3>
              <GatewayCapabilityOverrides
                models={models}
                onChange={draft.setModels}
              />
            </section>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || isSaving}>
            {isSaving
              ? "Saving..."
              : editProvider
                ? "Save changes"
                : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
