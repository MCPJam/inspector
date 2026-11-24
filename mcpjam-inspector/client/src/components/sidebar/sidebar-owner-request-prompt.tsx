import { buildUpgradeRequestMail } from "@/components/billing/RequestUpgradeButton";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import { useUpgradeRequestRecipients } from "@/hooks/use-upgrade-request-recipients";
import { track } from "@/lib/analytics";
import {
  SidebarPromptCard,
  sidebarPromptPage,
  useSidebarPromptShown,
} from "./sidebar-prompt-card";

/**
 * Free org, no billing rights: checkout would dead-end, so the card drafts
 * the upgrade request to the org's owners instead. Orgs on the legacy
 * catalog have no Pro to ask for.
 */
export function SidebarOwnerRequestPrompt({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const { recipients } = useUpgradeRequestRecipients(organizationId);
  const { planCatalog } = useOrganizationBilling(organizationId);
  const href = !planCatalog?.plans.pro
    ? null
    : buildUpgradeRequestMail({
        recipients,
        organizationName,
        teamName: "Pro",
        origin: "sidebar",
      });
  useSidebarPromptShown(href ? "owner_request" : null, organizationId);
  if (!href) return null;

  return (
    <SidebarPromptCard
      kind="owner_request"
      onClick={() => {
        track("upgrade_button_clicked", {
          location: "sidebar_prompt",
          prompt: "owner_request",
          organization_id: organizationId,
          plan: "free",
          target_plan: "pro",
          recipient_count: recipients.length,
          page: sidebarPromptPage(),
        });
        window.location.assign(href);
      }}
    />
  );
}
