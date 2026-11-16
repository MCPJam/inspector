import { TriangleAlert } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { gatewayHost } from "@/shared/gateway-connection";
import { pluralize } from "@/components/chat-v2/shared/chat-helpers";
import { STATUS_TONE_CLASSES } from "../org-ai-config-presentation";
import { blockedLabel, providerAttention } from "./gateway-works-with";

/**
 * The line under a custom provider's name: its host, how many models, and,
 * for an admin, what needs attention. Each badge opens the configure panel
 * where the fix is.
 */
export function CustomProviderStatus({
  provider,
  requireOrgKeys,
  onOpen,
}: {
  provider: OrgModelProvider;
  requireOrgKeys: boolean;
  /**
   * Absent for members, who can't change the provider. `works-with` asks for
   * the editor's "Works with" list.
   */
  onOpen?: (section?: "works-with") => void;
}) {
  const models =
    provider.models ??
    (provider.modelIds ?? []).map((nativeModelId) => ({ nativeModelId }));
  const attention = providerAttention({
    apis: provider.apis ?? [],
    runtimeLocation: provider.runtimeLocation ?? "cloud",
    models,
    requireOrgKeys,
  });
  const blocked = blockedLabel(attention.blocked);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span>{gatewayHost(provider.baseUrl ?? "") ?? provider.baseUrl}</span>
      <span aria-hidden="true">·</span>
      <span>{pluralize(models.length, "model")}</span>
      {provider.runtimeLocation === "local" ? (
        <>
          <span aria-hidden="true">·</span>
          <span>Calls from each user's Inspector</span>
        </>
      ) : null}
      {onOpen && attention.unmapped > 0 ? (
        <AttentionBadge
          label={`${attention.unmapped} not mapped`}
          onClick={() => onOpen()}
        />
      ) : null}
      {onOpen && blocked ? (
        <AttentionBadge label={blocked} onClick={() => onOpen("works-with")} />
      ) : null}
    </div>
  );
}

function AttentionBadge({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Badge
      asChild
      variant="outline"
      className={cn(
        STATUS_TONE_CLASSES.warning,
        "ml-1 cursor-pointer hover:underline",
      )}
    >
      <button type="button" onClick={onClick}>
        <TriangleAlert aria-hidden="true" />
        {label}
      </button>
    </Badge>
  );
}
