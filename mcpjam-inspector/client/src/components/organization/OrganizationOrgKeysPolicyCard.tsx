import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Switch } from "@mcpjam/design-system/switch";
import {
  useOrgAiConfig,
  type AiFeatureGroupReadiness,
  type AiOperationReadiness,
} from "@/hooks/useOrgAiConfig";
import {
  ORG_AI_ROLE_PRESENTATION,
  STATUS_TONE_CLASSES,
  degradationSentence,
  featureGuidance,
  featureLabel,
  listedBlockers,
  operationLabel,
  orderedFeatures,
  statusPresentation,
} from "./org-ai-config-presentation";

const TOGGLE_LABEL = "Use your keys for all AI features";

/**
 * "Use your keys for all AI features": when on, every AI request in the
 * organization must run on an approved organization provider, and anything
 * without one is unavailable rather than quietly falling back to an
 * MCPJam-provided model.
 *
 * Works with zero providers configured — turning it on first and adding keys
 * after is a legitimate order, and the coverage list then says exactly what
 * is unavailable. Renders nothing on a backend that cannot report the
 * setting, so it never suggests the policy is on (or off) when nobody knows.
 */
export function OrganizationOrgKeysPolicyCard({
  organizationId,
  isAdmin,
}: {
  organizationId: string;
  isAdmin: boolean;
}) {
  const { config, isLoading, unsupported, error, isSaving, setRequireOrgKeys } =
    useOrgAiConfig(organizationId);

  if (unsupported || config === null) return null;

  const configReady = config !== undefined;
  const canManage = isAdmin && config?.canManage !== false;
  const disabled = !canManage || isSaving || !configReady;
  const requireOrgKeys = config?.aiKeyPolicy.requireOrgKeys === true;

  return (
    <Card
      className="gap-4 border-0 bg-transparent py-0 shadow-none"
      data-testid="org-ai-keys-card"
    >
      <CardHeader className="px-0">
        <h2 className="text-sm font-medium text-muted-foreground">AI keys</h2>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {error ? (
          <Alert variant="destructive" data-testid="org-ai-keys-error">
            <AlertTitle>Couldn&apos;t save the AI keys setting</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{TOGGLE_LABEL}</p>
            <p className="text-xs text-muted-foreground">
              AI requests must use an approved organization provider.
              MCPJam-provided models are disabled. Features without a compatible
              provider are unavailable.
            </p>
          </div>
          {configReady ? (
            <Switch
              checked={requireOrgKeys}
              disabled={disabled}
              aria-label={TOGGLE_LABEL}
              data-testid="org-ai-keys-toggle"
              onCheckedChange={(checked) => {
                void setRequireOrgKeys(checked).catch(() => {
                  // The hook already shows the failure on this card
                  // (`useOrgScopedWrite`'s `error`); there is nothing more
                  // to do with it here.
                });
              }}
            />
          ) : (
            // Never an unchecked switch for a value nobody knows yet.
            <Skeleton
              className="h-5 w-9 rounded-full"
              data-testid="org-ai-keys-toggle-loading"
            />
          )}
        </div>

        {!canManage ? (
          <p className="text-xs text-muted-foreground">
            Only organization owners and admins can change this.
          </p>
        ) : null}
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : null}

        {config && !requireOrgKeys ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="org-ai-keys-off-summary"
          >
            MCPJam-provided models are used where you haven&apos;t chosen an
            organization model.
          </p>
        ) : null}

        {config && requireOrgKeys ? (
          <>
            <p
              className="text-xs text-muted-foreground"
              data-testid="org-ai-keys-billing"
            >
              Model tokens are billed by your providers. MCPJam product fees and
              usage limits still apply.
            </p>
            {config.readiness.eligibleConnectionIds.length === 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="org-ai-keys-no-eligible-provider"
              >
                {canManage
                  ? "No eligible organization provider is configured yet. Add a direct cloud provider below; OpenRouter and local providers don't qualify."
                  : "No eligible organization provider is configured yet. Ask an organization admin to add one."}
              </p>
            ) : null}
            <FeatureCoverage
              features={config.readiness.features}
              operations={config.readiness.operations ?? []}
              eligibleConnectionIds={config.readiness.eligibleConnectionIds}
              canManage={canManage}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FeatureCoverage({
  features,
  operations,
  eligibleConnectionIds,
  canManage,
}: {
  features: AiFeatureGroupReadiness[];
  operations: AiOperationReadiness[];
  eligibleConnectionIds?: string[];
  canManage: boolean;
}) {
  if (features.length === 0) return null;
  const operationById = new Map(operations.map((op) => [op.operation, op]));

  return (
    <section
      aria-labelledby="org-ai-feature-coverage-heading"
      className="space-y-2 pt-1"
    >
      <h3
        id="org-ai-feature-coverage-heading"
        className="text-xs font-medium text-muted-foreground"
      >
        Feature coverage
      </h3>
      <ul className="space-y-1">
        {orderedFeatures(features).map((feature) => {
          const { label, tone } = statusPresentation(feature.status);
          const guidance = featureGuidance(feature, {
            operations,
            eligibleConnectionIds,
            canManage,
          });
          // A blocked feature lists what blocks it (unless that is only the
          // feature itself); what would merely narrow it is noise until it
          // runs at all.
          const blockedBy = listedBlockers(feature);
          const degradedBy =
            feature.status === "ready" ? (feature.degradedBy ?? []) : [];
          return (
            <li
              key={feature.id}
              className="space-y-1 rounded-md border border-border/40 px-3 py-2.5"
              data-testid={`org-ai-feature-${feature.id}`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  {featureLabel(feature)}
                </span>
                <Badge
                  variant="outline"
                  className={cn(STATUS_TONE_CLASSES[tone])}
                  data-testid={`org-ai-feature-status-${feature.id}`}
                >
                  {label}
                </Badge>
              </div>
              {guidance ? (
                <p className="text-xs text-muted-foreground">{guidance}</p>
              ) : null}
              {blockedBy.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Blocked by{" "}
                  {blockedBy
                    .map((op) => {
                      const role = operationById.get(op)?.role;
                      const roleName = role
                        ? ORG_AI_ROLE_PRESENTATION[role]?.label
                        : undefined;
                      return roleName
                        ? `${operationLabel(op)} (${roleName} model)`
                        : operationLabel(op);
                    })
                    .join(", ")}
                </p>
              ) : null}
              {degradedBy.map((op) => (
                <p key={op} className="text-xs text-muted-foreground">
                  {degradationSentence(feature.id, op)}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
