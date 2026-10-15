import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { OrgAiCardBoundary, OrgAiConfigBoundary } from "./OrgAiConfigBoundary";
import { OrganizationDefaultModelCard } from "./OrganizationDefaultModelCard";
import { OrganizationOrgKeysPolicyCard } from "./OrganizationOrgKeysPolicyCard";

export function OrganizationAiCards({
  organizationId,
  isAdmin,
  providers,
}: {
  organizationId: string;
  isAdmin: boolean;
  providers: OrgModelProvider[] | undefined;
}) {
  return (
    <OrgAiConfigBoundary
      key={`org-ai-keys:${organizationId}`}
      name="org-ai-keys-policy"
    >
      <div className="space-y-6">
        <OrganizationOrgKeysPolicyCard
          organizationId={organizationId}
          isAdmin={isAdmin}
        />
        <OrgAiCardBoundary
          name="org-ai-default-model"
          title="the default AI model"
        >
          <OrganizationDefaultModelCard
            organizationId={organizationId}
            isAdmin={isAdmin}
            providers={providers}
          />
        </OrgAiCardBoundary>
      </div>
    </OrgAiConfigBoundary>
  );
}
