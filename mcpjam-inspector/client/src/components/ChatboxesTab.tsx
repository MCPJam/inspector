import { Suspense, lazy, useEffect } from "react";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import {
  getBillingUpsellCtaLabel,
  getBillingUpsellTeaser,
} from "@/lib/billing-upsell";
import { Loader2 } from "lucide-react";
import { BillingGateSurface } from "@/components/billing/BillingGateSurface";
import { BILLING_GATES, useWorkspaceBillingGate } from "@/lib/billing-gates";
import { clearBuilderSession } from "@/lib/chatbox-session";

const ChatboxBuilderExperience = lazy(
  () => import("@/components/chatboxes/builder/ChatboxBuilderExperience"),
);

interface ChatboxesTabProps {
  workspaceId: string | null;
  organizationId: string | null;
  isBillingContextPending?: boolean;
}

function ChatboxesLoadingState({
  testId = "chatboxes-loading-state",
  message = "Loading chatboxes...",
}: {
  testId?: string;
  message?: string;
}) {
  return (
    <div
      className="flex h-full min-h-[320px] items-center justify-center p-8"
      data-testid={testId}
    >
      <div className="text-center">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/**
 * Billing-related Convex failures from chatbox mutations use getBillingErrorMessage
 * in CreateChatboxDialog, ChatboxEditor, and ChatboxBuilderView.
 */
export function ChatboxesTab({
  workspaceId,
  organizationId,
  isBillingContextPending = false,
}: ChatboxesTabProps) {
  const resolvedOrganizationId = isBillingContextPending
    ? null
    : organizationId;
  const resolvedWorkspaceId = isBillingContextPending ? null : workspaceId;
  const chatboxGate = useWorkspaceBillingGate({
    workspaceId: resolvedWorkspaceId,
    organizationId: resolvedOrganizationId,
    gate: BILLING_GATES.chatboxes,
  });
  const chatboxCreationGate = useWorkspaceBillingGate({
    workspaceId: resolvedWorkspaceId,
    organizationId: resolvedOrganizationId,
    gate: BILLING_GATES.chatboxCreation,
  });
  const { planCatalog } = useOrganizationBilling(resolvedOrganizationId, {
    workspaceId: resolvedOrganizationId ? resolvedWorkspaceId : null,
  });
  const createChatboxUpsell =
    chatboxCreationGate.isDenied && chatboxCreationGate.denialMessage
      ? {
          title: "Need more chatboxes?",
          message: chatboxCreationGate.denialMessage,
          teaser: getBillingUpsellTeaser({
            planCatalog,
            upgradePlan: chatboxCreationGate.upgradePlan,
            intent: "chatboxes",
          }),
          canManageBilling: chatboxCreationGate.canManageBilling,
          ctaLabel: getBillingUpsellCtaLabel(chatboxCreationGate.upgradePlan),
          onNavigateToBilling: () => {
            if (chatboxCreationGate.organizationId) {
              window.location.hash = `organizations/${chatboxCreationGate.organizationId}/billing`;
            }
          },
        }
      : null;

  useEffect(() => {
    if (chatboxGate.isDenied) {
      clearBuilderSession();
    }
  }, [chatboxGate.isDenied]);

  if (isBillingContextPending) {
    return (
      <ChatboxesLoadingState
        testId="chatboxes-billing-context-pending"
        message="Checking your organization access..."
      />
    );
  }

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a workspace to manage chatboxes.
        </p>
      </div>
    );
  }

  return (
    <BillingGateSurface
      gate={chatboxGate}
      loadingFallback={<ChatboxesLoadingState />}
      onNavigateToBilling={(organizationId) => {
        window.location.hash = `organizations/${organizationId}/billing`;
      }}
    >
      <Suspense fallback={<ChatboxesLoadingState />}>
        <ChatboxBuilderExperience
          workspaceId={workspaceId}
          isCreateChatboxDisabled={chatboxCreationGate.isDenied}
          isCreateChatboxLoading={chatboxCreationGate.isLoading}
          createChatboxUpsell={createChatboxUpsell}
        />
      </Suspense>
    </BillingGateSurface>
  );
}
