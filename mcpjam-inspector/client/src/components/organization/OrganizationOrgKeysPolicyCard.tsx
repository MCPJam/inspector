import { useState } from "react";
import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Switch } from "@mcpjam/design-system/switch";
import {
  useOrgAiConfig,
  type AiFeatureGroupReadiness,
  type AiOperationReadiness,
} from "@/hooks/useOrgAiConfig";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";
import { enterpriseContactHref } from "./EnterpriseSettings";
import {
  STATUS_TONE_CLASSES,
  blockedBySentence,
  degradationSentence,
  featureGuidance,
  featureLabel,
  listedBlockers,
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
 * Enterprise only, and the backend decides: `canEnable` greys the switch out
 * (never the client's idea of the plan). An organization that left
 * Enterprise with the setting on keeps a working switch, so an admin can
 * always turn it off, and turning it off asks first.
 *
 * Works with zero providers configured: turning it on first and adding keys
 * after is a legitimate order, and the coverage list then says exactly what
 * is unavailable. On a backend that cannot report the whole setting, it says
 * the setting isn't available rather than showing a value nobody knows.
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
  const [confirmingOff, setConfirmingOff] = useState(false);

  if (config === null) return null;

  const configReady = config !== undefined;
  const canManage = isAdmin && config?.canManage !== false;
  const requireOrgKeys = orgRequiresOwnKeys(config);
  // Only the backend's answer locks it, and never while it is on: an org
  // that left Enterprise must still be able to turn it off.
  const enterpriseLocked = configReady && !config.canEnable && !requireOrgKeys;
  const leftEnterprise = configReady && !config.canEnable && requireOrgKeys;
  const disabled = !canManage || isSaving || !configReady || enterpriseLocked;
  const showConfirmOff = confirmingOff && requireOrgKeys && canManage;

  const turnOff = () => {
    void setRequireOrgKeys(false)
      .catch(() => {
        // The hook already shows the failure on this card
        // (`useOrgScopedWrite`'s `error`).
      })
      .finally(() => setConfirmingOff(false));
  };

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

        <div
          className={cn(
            "flex items-center justify-between gap-3",
            enterpriseLocked && "opacity-60",
          )}
          data-testid="org-ai-keys-setting"
        >
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{TOGGLE_LABEL}</p>
              {configReady && !config.canEnable ? (
                <Badge
                  variant="secondary"
                  className="text-xs uppercase tracking-wide"
                  data-testid="org-ai-keys-enterprise-badge"
                >
                  Enterprise
                </Badge>
              ) : null}
            </div>
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
                if (!checked) {
                  // Turning it off lets MCPJam-provided models touch this
                  // organization's data again: ask first.
                  setConfirmingOff(true);
                  return;
                }
                setConfirmingOff(false);
                void setRequireOrgKeys(true).catch(() => {
                  // Shown on this card by the hook's `error`.
                });
              }}
            />
          ) : unsupported ? null : (
            // Never an unchecked switch for a value nobody knows yet.
            <Skeleton
              className="h-5 w-9 rounded-full"
              data-testid="org-ai-keys-toggle-loading"
            />
          )}
        </div>

        {unsupported ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="org-ai-keys-unsupported"
          >
            This setting isn&apos;t available yet.
          </p>
        ) : null}

        {enterpriseLocked ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5"
            data-testid="org-ai-keys-enterprise-only"
          >
            <p className="text-sm text-muted-foreground">
              Available on Enterprise plans.
            </p>
            <Button asChild variant="outline" size="sm">
              <a href={enterpriseContactHref}>Contact us</a>
            </Button>
          </div>
        ) : null}

        {!canManage && configReady && !enterpriseLocked ? (
          <p className="text-xs text-muted-foreground">
            Only organization owners and admins can change this.
          </p>
        ) : null}
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : null}

        {leftEnterprise ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="org-ai-keys-left-enterprise"
          >
            This organization&apos;s plan no longer includes this setting. It
            stays on until an admin turns it off, and turning it back on needs
            an Enterprise plan.
          </p>
        ) : null}

        {showConfirmOff ? (
          <div
            role="group"
            aria-labelledby="org-ai-keys-confirm-off-title"
            className="space-y-3 rounded-md border border-border px-3 py-3"
            data-testid="org-ai-keys-confirm-off"
          >
            <div className="space-y-1">
              <p
                id="org-ai-keys-confirm-off-title"
                className="text-sm font-medium"
              >
                Turn off &ldquo;{TOGGLE_LABEL}&rdquo;?
              </p>
              <p className="text-xs text-muted-foreground">
                MCPJam-provided models will run on this organization&apos;s data
                again wherever nobody has chosen an organization model. The
                change is recorded in the audit log, and the organization&apos;s
                owners get an email.
                {leftEnterprise
                  ? " Turning it back on needs an Enterprise plan."
                  : ""}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isSaving}
                onClick={() => setConfirmingOff(false)}
              >
                Keep it on
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isSaving}
                onClick={turnOff}
                data-testid="org-ai-keys-confirm-off-button"
              >
                Turn off
              </Button>
            </div>
          </div>
        ) : null}

        {config && !requireOrgKeys && !enterpriseLocked ? (
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
              operations={config.readiness.operations}
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
            eligibleConnectionIds,
            canManage,
          });
          // A blocked feature lists what blocks it (never itself); what
          // would merely narrow it is noise until it runs at all.
          const blockedBy = blockedBySentence(listedBlockers(feature));
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
              {blockedBy ? (
                <p className="text-xs text-muted-foreground">{blockedBy}</p>
              ) : null}
              {degradedBy.map((op) => (
                <p key={op} className="text-xs text-muted-foreground">
                  {degradationSentence(
                    feature.id,
                    op,
                    operationById.get(op)?.status,
                  )}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
