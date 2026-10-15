import { useId, useState } from "react";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  orgAiModelSelectionKey,
  type OrgAiModelKind,
  type OrgAiModelTestResult,
} from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  ORG_AI_MODEL_PRESENTATION,
  STATUS_TONE_CLASSES,
  buildOrgModelSelection,
  listedModelFitsKind,
  listedModelIds,
  orgAiModelCheckPresentation,
  orgProviderLabel,
} from "./org-ai-config-presentation";

/** An organization connection the backend calls eligible, with its id. */
export type EligibleProvider = OrgModelProvider & { id: string };

/** The organization connection a saved selection names, if it names one. */
export function connectionIdOf(
  selection: ModelSelection | null | undefined,
): string | undefined {
  return selection?.connectionRef?.kind === "orgProvider"
    ? selection.connectionRef.id
    : undefined;
}

function initialNativeModel(selection: ModelSelection): string {
  return (
    selection.nativeModelId?.trim() ||
    selection.modelId.slice(selection.modelId.indexOf("/") + 1)
  );
}

/**
 * Choose a connection and type the model it runs. Nothing is saved until the
 * admin clicks Save; Test runs the typed model without saving it.
 */
export function ModelEditor({
  kind,
  initial,
  eligibleProviders,
  isSaving,
  isTesting,
  onCancel,
  onSave,
  onTest,
}: {
  kind: OrgAiModelKind;
  initial: ModelSelection | undefined;
  /** Backend-eligible connections; Test and Save validate model capability. */
  eligibleProviders: EligibleProvider[];
  isSaving: boolean;
  isTesting: boolean;
  onCancel: () => void;
  onSave: (selection: ModelSelection) => void;
  onTest: (
    candidate: ModelSelection,
  ) => Promise<OrgAiModelTestResult | undefined>;
}) {
  const { label, noun } = ORG_AI_MODEL_PRESENTATION[kind];
  const fieldId = useId();
  // Prefilled only from a connection that can still serve it. A removed one
  // is never swapped for another automatically; the admin picks.
  const initialConnectionId = connectionIdOf(initial);
  const initialProvider = initialConnectionId
    ? eligibleProviders.find((p) => p.id === initialConnectionId)
    : undefined;
  const [connectionId, setConnectionId] = useState(initialProvider?.id ?? "");
  const [model, setModel] = useState(
    initial && initialProvider ? initialNativeModel(initial) : "",
  );
  const [candidateCheck, setCandidateCheck] = useState<{
    key: string;
    result: OrgAiModelTestResult;
  } | null>(null);

  if (eligibleProviders.length === 0) {
    return <NoEligibleProvider noun={noun} onCancel={onCancel} />;
  }

  const provider = eligibleProviders.find((p) => p.id === connectionId);
  const candidate = provider ? buildOrgModelSelection(provider, model) : null;
  const candidateKey = candidate ? orgAiModelSelectionKey(candidate) : null;
  const candidateOutcome =
    candidateCheck && candidateCheck.key === candidateKey
      ? orgAiModelCheckPresentation(candidateCheck.result)
      : null;
  const listed = new Set(
    provider
      ? listedModelIds(provider).filter((id) => listedModelFitsKind(id, kind))
      : [],
  );
  if (initial && provider && initialConnectionId === provider.id) {
    listed.add(initialNativeModel(initial));
  }

  return (
    <div
      className="space-y-3 rounded-md bg-muted/40 p-3"
      data-testid={`org-ai-model-${kind}-editor`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ProviderField
          fieldId={fieldId}
          label={label}
          value={connectionId}
          providers={eligibleProviders}
          onChange={(next) => {
            setConnectionId(next);
            setCandidateCheck(null);
          }}
        />
        <ModelField
          fieldId={fieldId}
          label={label}
          isAzure={provider?.providerKey === "azure"}
          value={model}
          suggestions={[...listed]}
          onChange={setModel}
        />
      </div>

      <CandidateNotes
        kind={kind}
        invalid={Boolean(provider && model.trim() && !candidate)}
        candidate={candidate}
        outcome={candidateOutcome}
      />

      <EditorButtons
        noun={noun}
        canSave={Boolean(candidate) && !isSaving}
        canTest={Boolean(candidate) && !isTesting}
        onSave={() => {
          if (candidate) onSave(candidate);
        }}
        onTest={() => {
          if (!candidate || !candidateKey) return;
          void onTest(candidate).then((result) => {
            if (result) setCandidateCheck({ key: candidateKey, result });
          });
        }}
        onCancel={onCancel}
      />
    </div>
  );
}

function NoEligibleProvider({
  noun,
  onCancel,
}: {
  noun: string;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
      <p>
        No eligible organization provider. Add a direct cloud provider below to
        run the {noun}; OpenRouter and local providers aren&apos;t eligible.
      </p>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ProviderField({
  fieldId,
  label,
  value,
  providers,
  onChange,
}: {
  fieldId: string;
  label: string;
  value: string;
  providers: EligibleProvider[];
  onChange: (connectionId: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${fieldId}-provider`}>Provider</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={`${fieldId}-provider`}
          aria-label={`${label} provider`}
          className="w-full"
        >
          <SelectValue placeholder="Choose a provider" />
        </SelectTrigger>
        <SelectContent>
          {providers.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {orgProviderLabel(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ModelField({
  fieldId,
  label,
  isAzure,
  value,
  suggestions,
  onChange,
}: {
  fieldId: string;
  label: string;
  /** Azure is called with a deployment name, not a model id. */
  isAzure: boolean;
  value: string;
  /** Model ids the connection lists, offered as the admin types. */
  suggestions: string[];
  onChange: (model: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${fieldId}-model`}>
        {isAzure ? "Deployment name" : "Model"}
      </Label>
      <Input
        id={`${fieldId}-model`}
        aria-label={`${label} id`}
        list={`${fieldId}-models`}
        value={value}
        placeholder={isAzure ? "my-deployment" : "Provider model id"}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${fieldId}-models`}>
        {suggestions.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
    </div>
  );
}

/** What the typed model would be saved as, and its last test, if any. */
function CandidateNotes({
  kind,
  invalid,
  candidate,
  outcome,
}: {
  kind: OrgAiModelKind;
  /** A model was typed but can't form a selection. */
  invalid: boolean;
  candidate: ModelSelection | null;
  outcome: ReturnType<typeof orgAiModelCheckPresentation> | null;
}) {
  return (
    <>
      {invalid ? (
        <p className="text-xs text-destructive">
          Enter the model id the provider uses, for example its API model name.
        </p>
      ) : null}
      {candidate ? (
        <p className="break-all text-xs text-muted-foreground">
          Saved as {candidate.modelId}
        </p>
      ) : null}
      {outcome ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Test</span>
          <Badge
            variant="outline"
            className={cn(STATUS_TONE_CLASSES[outcome.tone])}
            data-testid={`org-ai-model-${kind}-candidate-outcome`}
          >
            {outcome.label}
          </Badge>
        </div>
      ) : null}
    </>
  );
}

function EditorButtons({
  noun,
  canSave,
  canTest,
  onSave,
  onTest,
  onCancel,
}: {
  noun: string;
  canSave: boolean;
  canTest: boolean;
  onSave: () => void;
  onTest: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={!canSave} onClick={onSave}>
        Save
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label={`Test this ${noun}`}
        disabled={!canTest}
        onClick={onTest}
      >
        Test
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
