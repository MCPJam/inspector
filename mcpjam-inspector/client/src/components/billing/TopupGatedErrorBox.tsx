import { useUpgradeCheckout } from "@/hooks/use-upgrade-checkout";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import type { ComponentProps } from "react";

import { ErrorBox } from "@/components/chat-v2/error";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditTopupPresets } from "@/hooks/useCreditTopup";

type ErrorBoxProps = ComponentProps<typeof ErrorBox>;
type TopupGatedErrorBoxProps = ErrorBoxProps & {
  /** Whether the current user may purchase credits for the active org.
   * Members request credits; Free admins and members request an upgrade. */
  canManageCredits?: boolean;
  organizationId?: string | null;
};

function GatedInner({
  canTopUp: _canTopUp,
  onTopUp,
  canManageCredits,
  organizationId,
  ...rest
}: TopupGatedErrorBoxProps) {
  const { effectivePlan, canManageBilling, isLoadingBilling } =
    useUpgradeCheckout({
      organizationId: organizationId ?? null,
      origin: "credits",
      limitKind: "credits",
    });
  const free = effectivePlan === "free";
  const { presets } = useCreditTopupPresets({
    skip: isLoadingBilling || free || !canManageCredits,
  });
  const showCta =
    !isLoadingBilling &&
    (free || !canManageCredits || (presets?.length ?? 0) > 0);
  const label = free
    ? canManageBilling
      ? "Compare plans"
      : "Request upgrade"
    : canManageCredits
    ? "Buy credits to keep chatting"
    : "Request credits";
  return (
    <ErrorBox
      {...rest}
      canTopUp={showCta}
      creditActionLabel={label}
      onTopUp={
        showCta
          ? free || !canManageCredits
            ? () =>
                useMCPJamLimitDialogStore
                  .getState()
                  .notifyLimitHit({
                    organizationId: organizationId ?? undefined,
                  })
            : onTopUp
          : undefined
      }
    />
  );
}

export function TopupGatedErrorBox({
  canManageCredits = false,
  ...props
}: TopupGatedErrorBoxProps) {
  const plainErrorBox = (
    <ErrorBox {...props} canTopUp={false} onTopUp={undefined} />
  );
  if (props.canTopUp !== true) return plainErrorBox;
  return (
    <ErrorBoundary fallback={plainErrorBox}>
      <GatedInner {...props} canManageCredits={canManageCredits} />
    </ErrorBoundary>
  );
}
