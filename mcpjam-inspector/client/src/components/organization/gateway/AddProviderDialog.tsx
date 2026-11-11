/**
 * "Add custom provider": a base URL, a key and a Test. After a passing Test,
 * "Add provider" saves every default the Test produced: a name from the host,
 * calls from MCPJam's servers, the APIs that answered and the suggested model
 * mappings. Everything else is set later in the configure panel.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
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
import type { UpsertOrgProviderArgs } from "@/hooks/use-org-model-config";
import { pluralize } from "@/components/chat-v2/shared/chat-helpers";
import { GatewayConnectionFields, GatewayTestAlert } from "./GatewayFormParts";
import { GatewayAddModel } from "./GatewayModelTable";
import { GatewayApiList } from "./GatewayReadiness";
import { suggestedGatewayName } from "./gateway-test-outcome";
import { useGatewayDraft } from "./use-gateway-draft";

/** The slug a new provider is saved under. */
const providerKeyFor = (name: string) =>
  `custom:${name.trim().toLowerCase().replace(/\s+/g, "-")}`;

export function AddProviderDialog({
  open,
  onOpenChange,
  organizationId,
  existingProviderKeys,
  isSaving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  existingProviderKeys: readonly string[];
  isSaving: boolean;
  onSave: (args: UpsertOrgProviderArgs) => Promise<void>;
}) {
  const draft = useGatewayDraft({
    open,
    onOpenChange,
    organizationId,
    editProvider: null,
    isSaving,
  });
  /** The admin's name; null keeps the one from the host. */
  const [renamed, setRenamed] = useState<string | null>(null);
  useEffect(() => {
    if (open) setRenamed(null);
  }, [open]);

  const { outcome, passed, models, apis } = draft;
  const trimmedName = (renamed ?? suggestedGatewayName(draft.baseUrl)).trim();
  const nameProblem = !trimmedName
    ? "Enter a name."
    : /[/:]/.test(trimmedName)
      ? "Use a name without slashes or colons."
      : existingProviderKeys.includes(providerKeyFor(trimmedName))
        ? `A custom provider named "${trimmedName}" already exists. Choose another name.`
        : null;
  // The provider answered but listed nothing, so no API could be tried
  // either: the admin names a model and the APIs it serves.
  const listedNone = passed && draft.tested?.models.length === 0;
  const canSave =
    passed && !nameProblem && apis.length > 0 && models.length > 0;

  const save = () =>
    void onSave({
      providerKey: providerKeyFor(trimmedName),
      displayName: trimmedName,
      ...draft.connection,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-left">Add custom provider</DialogTitle>
          <DialogDescription className="text-left">
            Connect an OpenAI- or Anthropic-compatible provider, such as a
            LiteLLM proxy. Test it, then add it.
          </DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void draft.runTest();
          }}
        >
          <GatewayConnectionFields
            draft={draft}
            hasSecret={false}
            action={
              <Button
                type="submit"
                variant="outline"
                disabled={!draft.baseUrl.trim() || draft.testing}
              >
                {draft.testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {draft.testing ? "Testing..." : "Test"}
              </Button>
            }
          />
        </form>

        {outcome && outcome.tone !== "success" ? (
          <GatewayTestAlert
            outcome={outcome}
            onUseInspector={draft.testFromInspector}
          />
        ) : null}

        {passed ? (
          <div className="min-w-0 space-y-3">
            {outcome?.tone === "success" ? (
              <PassedLine models={models.length} apis={apis.length} />
            ) : null}
            {renamed !== null || nameProblem ? (
              <div className="space-y-2">
                <Label htmlFor="gateway-name">Name</Label>
                <Input
                  id="gateway-name"
                  value={renamed ?? trimmedName}
                  autoFocus={renamed !== null}
                  onChange={(event) => setRenamed(event.target.value)}
                  aria-invalid={!!nameProblem}
                  aria-describedby={
                    nameProblem ? "gateway-name-problem" : undefined
                  }
                />
                {nameProblem ? (
                  <p
                    id="gateway-name-problem"
                    className="text-sm text-destructive"
                  >
                    {nameProblem}
                  </p>
                ) : null}
              </div>
            ) : (
              <p
                className={cn(
                  "text-sm text-muted-foreground",
                  outcome?.tone === "success" && "-mt-2 pl-6",
                )}
              >
                Saves as{" "}
                <span className="font-medium text-foreground">
                  {trimmedName}
                </span>
                {draft.runtime === "local"
                  ? ", with calls from each user's Inspector."
                  : null}{" "}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-1 py-0"
                  onClick={() => setRenamed(trimmedName)}
                >
                  Rename
                </Button>
              </p>
            )}
            {listedNone ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <GatewayAddModel models={models} onChange={draft.setModels} />
                  {models.length > 0 ? (
                    <p className="font-mono text-xs text-muted-foreground">
                      {models.map((model) => model.nativeModelId).join(", ")}
                    </p>
                  ) : null}
                </div>
                <GatewayApiList
                  selected={apis}
                  results={draft.results}
                  onChange={draft.setApis}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || isSaving}>
            {isSaving ? "Adding..." : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A passing Test, in one line. */
export function PassedLine({ models, apis }: { models: number; apis: number }) {
  return (
    <div role="status" className="flex items-start gap-2 text-sm">
      <CheckCircle2
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-success"
      />
      <p>
        <span className="font-medium">Connected.</span> Found{" "}
        {pluralize(models, "model")} and {pluralize(apis, "API")}.
      </p>
    </div>
  );
}
