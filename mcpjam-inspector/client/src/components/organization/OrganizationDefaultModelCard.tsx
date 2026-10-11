import { useId, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
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
  orgAiModelsOf,
  useOrgAiConfig,
  type OrgAiModelCheck,
  type OrgAiModelEntry,
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
  providerServesModelKind,
  selectionModelLabel,
} from "./org-ai-config-presentation";

const TOGGLE_LABEL = "Use your keys for all AI features";

type EligibleProvider = OrgModelProvider & { id: string };

function connectionIdOf(
  selection: ModelSelection | null | undefined,
): string | undefined {
  return selection?.connectionRef?.kind === "orgProvider"
    ? selection.connectionRef.id
    : undefined;
}

function sameSelection(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return orgAiModelSelectionKey(a) === orgAiModelSelectionKey(b);
}

function relativeTime(timestamp: number): string {
  try {
    return formatDistanceToNow(timestamp, { addSuffix: true });
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

/**
 * The organization's default AI model: the one model background AI work
 * runs on while "Use your keys for all AI features" is on (insights and
 * findings, generation, typed decisions, simulated users). One row per kind
 * the backend supports, so an embedding or transcription model appears when
 * the backend serves one, with no change here.
 *
 * Nothing here saves on its own: a suggestion is applied only when an admin
 * clicks it, and a saved model that can no longer run stays visible with the
 * backend's reason rather than being pointed somewhere else. Model pickers
 * never use it, and each suite still chooses its own judge.
 *
 * Enterprise only, from the backend's `canEnable`, like the switch above it.
 * A model saved before the organization left Enterprise stays visible and can
 * still be cleared. Members see it read-only. On a backend that does not
 * report organization AI models, it renders nothing.
 */
export function OrganizationDefaultModelCard({
  organizationId,
  isAdmin,
  providers,
}: {
  organizationId: string;
  isAdmin: boolean;
  /** The organization's provider rows, from `useOrgModelConfig`. */
  providers: OrgModelProvider[] | undefined;
}) {
  const {
    config,
    unsupported,
    error,
    isSaving,
    testError,
    isTesting,
    setAiModel,
    testAiModel,
  } = useOrgAiConfig(organizationId);

  const [editingKind, setEditingKind] = useState<OrgAiModelKind | null>(null);
  const [testingKind, setTestingKind] = useState<OrgAiModelKind | null>(null);
  const [pendingEmbeddingChange, setPendingEmbeddingChange] = useState<{
    selection: ModelSelection | null;
    onSaved?: () => void;
  } | null>(null);

  const aiModels = unsupported ? null : orgAiModelsOf(config);
  if (!config || !aiModels) return null;

  const canManage = isAdmin && config.canManage !== false;
  // Only the backend's answer locks it. Clearing a saved model never is.
  const locked = !config.canEnable;
  const canChange = canManage && !locked;
  const requireOrgKeys = config.aiKeyPolicy.requireOrgKeys;
  const eligibleIds = new Set(config.readiness.eligibleConnectionIds);
  const eligibleProviders = (providers ?? []).filter(
    (p): p is EligibleProvider =>
      typeof p.id === "string" && eligibleIds.has(p.id),
  );
  const suggestions = canChange ? aiModels.suggestions : {};
  const title =
    aiModels.kinds.length === 1 ? "Default AI model" : "Default AI models";

  const commit = async (
    kind: OrgAiModelKind,
    selection: ModelSelection | null,
    onSaved?: () => void,
  ) => {
    try {
      await setAiModel(kind, selection);
      onSaved?.();
    } catch {
      // The hook keeps the backend's message for the alert below.
    }
  };

  /**
   * Save, unless the embedding model changes: vectors from two embedding
   * models are never compared, so that change is confirmed first.
   */
  const requestSave = (
    kind: OrgAiModelKind,
    selection: ModelSelection | null,
    onSaved?: () => void,
  ) => {
    if (
      kind === "embedding" &&
      !sameSelection(selection, aiModels.models.embedding?.selection)
    ) {
      setPendingEmbeddingChange({ selection, onSaved });
      return;
    }
    void commit(kind, selection, onSaved);
  };

  const runTest = async (
    kind: OrgAiModelKind,
    candidate?: ModelSelection,
  ): Promise<OrgAiModelTestResult | undefined> => {
    setTestingKind(kind);
    try {
      return await testAiModel(kind, candidate);
    } catch {
      // The hook keeps the message for the alert below.
      return undefined;
    } finally {
      setTestingKind(null);
    }
  };

  return (
    <Card
      className="gap-4 border-0 bg-transparent py-0 shadow-none"
      data-testid="org-ai-default-model-card"
    >
      <CardHeader className="px-0">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              {title}
            </h2>
            {locked ? (
              <Badge
                variant="secondary"
                className="text-xs uppercase tracking-wide"
                data-testid="org-ai-default-model-enterprise-badge"
              >
                Enterprise
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Background AI work that nobody picks a model for runs on the model
            chosen here while &ldquo;{TOGGLE_LABEL}&rdquo; is on.{" "}
            {requireOrgKeys
              ? "Without it, that work is unavailable."
              : "Until then, MCPJam-provided models run it."}{" "}
            Model pickers never use it, and each suite still chooses its own
            judge.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {error ? (
          <Alert variant="destructive" data-testid="org-ai-default-model-error">
            <AlertTitle>Couldn&apos;t save the model</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {testError ? (
          <Alert
            variant="destructive"
            data-testid="org-ai-default-model-test-error"
          >
            <AlertTitle>Couldn&apos;t test the model</AlertTitle>
            <AlertDescription>{testError}</AlertDescription>
          </Alert>
        ) : null}

        {locked ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="org-ai-default-model-enterprise-only"
          >
            Available on Enterprise plans.
          </p>
        ) : null}
        {!canManage && !locked ? (
          <p className="text-xs text-muted-foreground">
            Only organization owners and admins can change this.
          </p>
        ) : null}

        <ul className="space-y-1">
          {aiModels.kinds.map((kind) => {
            const entry = aiModels.models[kind] ?? null;
            const suggestion = entry ? undefined : suggestions[kind];
            return (
              <ModelRow
                key={kind}
                kind={kind}
                entry={entry}
                suggestion={suggestion}
                providers={providers}
                canManage={canManage}
                canChange={canChange}
                locked={locked}
                isSaving={isSaving}
                isTesting={isTesting}
                isTestingThis={testingKind === kind}
                editing={editingKind === kind && canChange}
                eligibleProviders={eligibleProviders.filter((p) =>
                  providerServesModelKind(p.providerKey, kind),
                )}
                onEdit={() => setEditingKind(kind)}
                onCancelEdit={() => setEditingKind(null)}
                onTestSaved={() => void runTest(kind)}
                onTestCandidate={(candidate) => runTest(kind, candidate)}
                onSave={(next) =>
                  requestSave(kind, next, () => setEditingKind(null))
                }
                onUseSuggestion={(next) => requestSave(kind, next)}
                onClear={() => requestSave(kind, null)}
              />
            );
          })}
        </ul>
      </CardContent>

      <AlertDialog
        open={pendingEmbeddingChange !== null}
        onOpenChange={(next) => {
          if (!next && !isSaving) setPendingEmbeddingChange(null);
        }}
      >
        <AlertDialogContent data-testid="org-ai-embedding-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Change the embedding model?</AlertDialogTitle>
            <AlertDialogDescription>
              The session map and clustering only compare vectors made by the
              same embedding model, so sessions embedded with the current model
              won&apos;t be compared with sessions embedded with the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSaving}
              onClick={(event) => {
                event.preventDefault();
                const pending = pendingEmbeddingChange;
                if (!pending) return;
                void commit(
                  "embedding",
                  pending.selection,
                  pending.onSaved,
                ).finally(() => setPendingEmbeddingChange(null));
              }}
            >
              {isSaving ? "Saving…" : "Change embedding model"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function SelectionSummary({
  selection,
  label,
  providers,
}: {
  selection: ModelSelection;
  /** The backend's name for the model, when it has one. */
  label?: string;
  providers: OrgModelProvider[] | undefined;
}) {
  const id = connectionIdOf(selection);
  const provider = id ? providers?.find((p) => p.id === id) : undefined;
  const model = label?.trim() || selectionModelLabel(selection);
  return <>{provider ? `${orgProviderLabel(provider)} · ${model}` : model}</>;
}

function CheckLine({ check }: { check: OrgAiModelCheck | null }) {
  if (!check) {
    return <span>Not tested yet</span>;
  }
  const outcome = orgAiModelCheckPresentation(check);
  return (
    <>
      <span>Last test</span>
      <Badge
        variant="outline"
        className={cn(STATUS_TONE_CLASSES[outcome.tone])}
      >
        {outcome.label}
      </Badge>
      <span>{relativeTime(check.checkedAt)}</span>
    </>
  );
}

function ModelRow({
  kind,
  entry,
  suggestion,
  providers,
  canManage,
  canChange,
  locked,
  isSaving,
  isTesting,
  isTestingThis,
  editing,
  eligibleProviders,
  onEdit,
  onCancelEdit,
  onTestSaved,
  onTestCandidate,
  onSave,
  onUseSuggestion,
  onClear,
}: {
  kind: OrgAiModelKind;
  entry: OrgAiModelEntry | null;
  suggestion: ModelSelection | undefined;
  providers: OrgModelProvider[] | undefined;
  canManage: boolean;
  /** An admin on a plan that allows choosing a model. */
  canChange: boolean;
  locked: boolean;
  isSaving: boolean;
  isTesting: boolean;
  isTestingThis: boolean;
  editing: boolean;
  eligibleProviders: EligibleProvider[];
  onEdit: () => void;
  onCancelEdit: () => void;
  onTestSaved: () => void;
  onTestCandidate: (
    candidate: ModelSelection,
  ) => Promise<OrgAiModelTestResult | undefined>;
  onSave: (selection: ModelSelection) => void;
  onUseSuggestion: (selection: ModelSelection) => void;
  onClear: () => void;
}) {
  const { label, noun, runs } = ORG_AI_MODEL_PRESENTATION[kind];
  const selection = entry?.selection;
  // A model that can't run (its connection was removed, …) is re-chosen,
  // not tested: the test would only repeat the backend's reason.
  const testable = Boolean(selection) && canChange && !entry?.problem;

  return (
    <li
      className={cn(
        "space-y-2 rounded-md border border-border/40 px-3 py-2.5",
        locked && !selection && "opacity-60",
      )}
      data-testid={`org-ai-model-${kind}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{runs}</p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-1">
            {testable ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Test ${noun}`}
                disabled={isTesting}
                onClick={onTestSaved}
              >
                {isTestingThis ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Test
              </Button>
            ) : null}
            {canChange && !editing ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${selection ? "Change" : "Set"} ${noun}`}
                onClick={onEdit}
              >
                {selection ? "Change" : "Set"}
              </Button>
            ) : null}
            {selection ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Clear ${noun}`}
                disabled={isSaving}
                onClick={onClear}
              >
                Clear
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        className="space-y-1 text-xs"
        data-testid={`org-ai-model-${kind}-saved`}
      >
        {selection ? (
          <>
            {entry?.problem ? (
              <p className="text-destructive">{entry.problem.message}</p>
            ) : null}
            <p className="break-all text-foreground">
              <SelectionSummary
                selection={selection}
                label={entry?.label}
                providers={providers}
              />
            </p>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <CheckLine check={entry?.check ?? null} />
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">
              Not set
              {suggestion ? (
                <>
                  {" · Suggested: "}
                  <SelectionSummary
                    selection={suggestion}
                    providers={providers}
                  />
                </>
              ) : null}
            </p>
            {suggestion && canChange ? (
              <Button
                variant="outline"
                size="sm"
                disabled={isSaving}
                onClick={() => onUseSuggestion(suggestion)}
              >
                Use suggested model
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {editing ? (
        <ModelEditor
          kind={kind}
          initial={selection ?? suggestion}
          eligibleProviders={eligibleProviders}
          isSaving={isSaving}
          isTesting={isTesting}
          onCancel={onCancelEdit}
          onSave={onSave}
          onTest={onTestCandidate}
        />
      ) : null}
    </li>
  );
}

function initialNativeModel(selection: ModelSelection): string {
  return (
    selection.nativeModelId?.trim() ||
    selection.modelId.slice(selection.modelId.indexOf("/") + 1)
  );
}

function ModelEditor({
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
  /** Eligible connections whose provider can serve this kind. */
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
    return (
      <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>
          No eligible organization provider can run the {noun}. Add a direct
          cloud provider below; OpenRouter and local providers aren&apos;t
          eligible.
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
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
  const isAzure = provider?.providerKey === "azure";

  return (
    <div
      className="space-y-3 rounded-md bg-muted/40 p-3"
      data-testid={`org-ai-model-${kind}-editor`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-provider`}>Provider</Label>
          <Select
            value={connectionId}
            onValueChange={(next) => {
              setConnectionId(next);
              setCandidateCheck(null);
            }}
          >
            <SelectTrigger
              id={`${fieldId}-provider`}
              aria-label={`${label} provider`}
              className="w-full"
            >
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent>
              {eligibleProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {orgProviderLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-model`}>
            {isAzure ? "Deployment name" : "Model"}
          </Label>
          <Input
            id={`${fieldId}-model`}
            aria-label={`${label} id`}
            list={`${fieldId}-models`}
            value={model}
            placeholder={isAzure ? "my-deployment" : "Provider model id"}
            autoComplete="off"
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id={`${fieldId}-models`}>
            {[...listed].map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </div>
      </div>

      {provider && model.trim() && !candidate ? (
        <p className="text-xs text-destructive">
          Enter the model id the provider uses, for example its API model name.
        </p>
      ) : null}
      {candidate ? (
        <p className="break-all text-xs text-muted-foreground">
          Saved as {candidate.modelId}
        </p>
      ) : null}
      {candidateOutcome ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Test</span>
          <Badge
            variant="outline"
            className={cn(STATUS_TONE_CLASSES[candidateOutcome.tone])}
            data-testid={`org-ai-model-${kind}-candidate-outcome`}
          >
            {candidateOutcome.label}
          </Badge>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!candidate || isSaving}
          onClick={() => {
            if (candidate) onSave(candidate);
          }}
        >
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Test this ${noun}`}
          disabled={!candidate || isTesting}
          onClick={() => {
            if (!candidate || !candidateKey) return;
            void onTest(candidate).then((result) => {
              if (result) setCandidateCheck({ key: candidateKey, result });
            });
          }}
        >
          Test
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
