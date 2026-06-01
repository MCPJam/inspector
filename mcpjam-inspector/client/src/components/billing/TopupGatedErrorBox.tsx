import type { ComponentProps } from "react";

import { ErrorBox } from "@/components/chat-v2/error";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditTopupPresets } from "@/hooks/useCreditTopup";

type ErrorBoxProps = ComponentProps<typeof ErrorBox>;
type TopupGatedErrorBoxProps = ErrorBoxProps & {
  /** Whether the current user may purchase credits for the active org.
   * When false, the buy button is replaced by an "ask org admin" hint. */
  canManageCredits?: boolean;
};

function GatedInner({ canTopUp, onTopUp, ...rest }: ErrorBoxProps) {
  const { presets } = useCreditTopupPresets({ skip: canTopUp !== true });
  const hasPresets = (presets?.length ?? 0) > 0;
  const showCta = canTopUp === true && hasPresets;
  return (
    <ErrorBox
      {...rest}
      canTopUp={showCta}
      onTopUp={showCta ? onTopUp : undefined}
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
  // Top-up isn't the relevant fix for this error — render plainly.
  if (props.canTopUp !== true) return plainErrorBox;
  // Top-up is relevant but the user can't buy credits: point them at an
  // admin instead of a button the backend would reject. No need to load
  // presets in this case.
  if (!canManageCredits) {
    return (
      <ErrorBox {...props} canTopUp={false} onTopUp={undefined} askAdminToTopUp />
    );
  }
  return (
    <ErrorBoundary fallback={plainErrorBox}>
      <GatedInner {...props} />
    </ErrorBoundary>
  );
}
