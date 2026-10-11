import { formatDistanceToNow } from "date-fns";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import { cn } from "@mcpjam/design-system/cn";
import {
  orgAiModelsOf,
  useOrgAiConfig,
  type OrgAiModelCheck,
  type OrgAiModelEntry,
  type OrgAiModelKind,
} from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  ORG_AI_MODEL_PRESENTATION,
  STATUS_TONE_CLASSES,
  orgAiModelCheckPresentation,
  orgProviderLabel,
  selectionModelLabel,
} from "./org-ai-config-presentation";

const TOGGLE_LABEL = "Use your keys for all AI features";

function connectionIdOf(
  selection: ModelSelection | null | undefined,
): string | undefined {
  return selection?.connectionRef?.kind === "orgProvider"
    ? selection.connectionRef.id
    : undefined;
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
  const { config, unsupported } = useOrgAiConfig(organizationId);

  const aiModels = unsupported ? null : orgAiModelsOf(config);
  if (!config || !aiModels) return null;

  const canManage = isAdmin && config.canManage !== false;
  // Only the backend's answer locks it. Clearing a saved model never is.
  const locked = !config.canEnable;
  const canChange = canManage && !locked;
  const requireOrgKeys = config.aiKeyPolicy.requireOrgKeys;
  const suggestions = canChange ? aiModels.suggestions : {};
  const title =
    aiModels.kinds.length === 1 ? "Default AI model" : "Default AI models";

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
                locked={locked}
              />
            );
          })}
        </ul>
      </CardContent>
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
  locked,
}: {
  kind: OrgAiModelKind;
  entry: OrgAiModelEntry | null;
  suggestion: ModelSelection | undefined;
  providers: OrgModelProvider[] | undefined;
  locked: boolean;
}) {
  const { label, runs } = ORG_AI_MODEL_PRESENTATION[kind];
  const selection = entry?.selection;

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
          </div>
        )}
      </div>
    </li>
  );
}
