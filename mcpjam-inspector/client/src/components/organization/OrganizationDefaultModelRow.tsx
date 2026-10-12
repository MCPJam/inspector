import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type {
  OrgAiModelCheck,
  OrgAiModelEntry,
  OrgAiModelKind,
  OrgAiModelTestResult,
} from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  ORG_AI_MODEL_PRESENTATION,
  STATUS_TONE_CLASSES,
  orgAiModelCheckPresentation,
  orgProviderLabel,
  selectionModelLabel,
} from "./org-ai-config-presentation";
import {
  ModelEditor,
  connectionIdOf,
  type EligibleProvider,
} from "./OrganizationDefaultModelEditor";

/** What the viewer may do with a row. */
export type DefaultModelRowAccess = {
  /** An organization owner or admin: the row shows its actions. */
  canManage: boolean;
  /** An admin on a plan that allows choosing a model. */
  canChange: boolean;
  /** Not on Enterprise: a row with no saved model reads as unavailable. */
  locked: boolean;
};

/** What the card is busy with. */
export type DefaultModelRowBusy = {
  isSaving: boolean;
  isTesting: boolean;
  /** The running test is this row's. */
  isTestingThis: boolean;
};

/** What the row's buttons and editor ask the card to do. */
export type DefaultModelRowActions = {
  onEdit: () => void;
  onCancelEdit: () => void;
  onTestSaved: () => void;
  onTestCandidate: (
    candidate: ModelSelection,
  ) => Promise<OrgAiModelTestResult | undefined>;
  onSave: (selection: ModelSelection) => void;
  onUseSuggestion: (selection: ModelSelection) => void;
  onClear: () => void;
};

function relativeTime(timestamp: number): string {
  try {
    return formatDistanceToNow(timestamp, { addSuffix: true });
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

/** One kind's row: its saved (or suggested) model, its actions, its editor. */
export function ModelRow({
  kind,
  entry,
  suggestion,
  providers,
  access,
  busy,
  editor,
  actions,
}: {
  kind: OrgAiModelKind;
  entry: OrgAiModelEntry | null;
  suggestion: ModelSelection | undefined;
  providers: OrgModelProvider[] | undefined;
  access: DefaultModelRowAccess;
  busy: DefaultModelRowBusy;
  /** While editing: eligible connections, unresolved until metadata arrives. */
  editor: { eligibleProviders: EligibleProvider[] | undefined } | null;
  actions: DefaultModelRowActions;
}) {
  const { label, runs } = ORG_AI_MODEL_PRESENTATION[kind];
  const selection = entry?.selection;

  return (
    <li
      className={cn(
        "space-y-2 rounded-md border border-border/40 px-3 py-2.5",
        access.locked && !selection && "opacity-60",
      )}
      data-testid={`org-ai-model-${kind}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{runs}</p>
        </div>
        {access.canManage ? (
          <ModelRowButtons
            kind={kind}
            entry={entry}
            canChange={access.canChange}
            busy={busy}
            editing={editor !== null}
            actions={actions}
          />
        ) : null}
      </div>

      <SavedModel
        kind={kind}
        entry={entry}
        suggestion={suggestion}
        providers={providers}
        canChange={access.canChange}
        isSaving={busy.isSaving}
        onUseSuggestion={actions.onUseSuggestion}
      />

      {editor && editor.eligibleProviders === undefined ? (
        <div className="flex items-center gap-2">
          <p
            className="text-xs text-muted-foreground"
            role="status"
            data-testid={`org-ai-model-${kind}-provider-loading`}
          >
            Loading organization providers.
          </p>
          <Button variant="ghost" size="sm" onClick={actions.onCancelEdit}>
            Cancel
          </Button>
        </div>
      ) : editor?.eligibleProviders ? (
        <ModelEditor
          kind={kind}
          initial={selection ?? suggestion}
          eligibleProviders={editor.eligibleProviders}
          isSaving={busy.isSaving}
          isTesting={busy.isTesting}
          onCancel={actions.onCancelEdit}
          onSave={actions.onSave}
          onTest={actions.onTestCandidate}
        />
      ) : null}
    </li>
  );
}

function ModelRowButtons({
  kind,
  entry,
  canChange,
  busy,
  editing,
  actions,
}: {
  kind: OrgAiModelKind;
  entry: OrgAiModelEntry | null;
  canChange: boolean;
  busy: DefaultModelRowBusy;
  editing: boolean;
  actions: DefaultModelRowActions;
}) {
  const { noun } = ORG_AI_MODEL_PRESENTATION[kind];
  const selection = entry?.selection;
  // A model that can't run (its connection was removed, …) is re-chosen,
  // not tested: the test would only repeat the backend's reason.
  const testable = Boolean(selection) && canChange && !entry?.problem;

  return (
    <div className="flex items-center gap-1">
      {testable ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Test ${noun}`}
          disabled={busy.isTesting}
          onClick={actions.onTestSaved}
        >
          {busy.isTestingThis ? (
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
          onClick={actions.onEdit}
        >
          {selection ? "Change" : "Set"}
        </Button>
      ) : null}
      {selection ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Clear ${noun}`}
          disabled={busy.isSaving}
          onClick={actions.onClear}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}

/** The saved model and its last test, or "Not set" with any suggestion. */
function SavedModel({
  kind,
  entry,
  suggestion,
  providers,
  canChange,
  isSaving,
  onUseSuggestion,
}: {
  kind: OrgAiModelKind;
  entry: OrgAiModelEntry | null;
  suggestion: ModelSelection | undefined;
  providers: OrgModelProvider[] | undefined;
  /** An admin on a plan that allows choosing a model. */
  canChange: boolean;
  isSaving: boolean;
  onUseSuggestion: (selection: ModelSelection) => void;
}) {
  const selection = entry?.selection;
  return (
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
                {" · Suggested model "}
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
  return (
    <>
      {provider
        ? `${orgProviderLabel(provider)} · ${model}`
        : id && providers !== undefined
          ? `${id} · ${model}`
          : model}
    </>
  );
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
