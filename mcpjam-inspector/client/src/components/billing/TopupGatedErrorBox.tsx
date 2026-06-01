import type { ComponentProps } from "react";

import { ErrorBox } from "@/components/chat-v2/error";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditTopupPresets } from "@/hooks/useCreditTopup";
import { useCreditTopupsUiEnabled } from "@/lib/credit-topups-flag";

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
  const creditsUiEnabled = useCreditTopupsUiEnabled();
  const plainErrorBox = (
    <ErrorBox {...props} canTopUp={false} onTopUp={undefined} />
  );
  // Top-up isn't the relevant fix for this error — render plainly.
  if (props.canTopUp !== true) return plainErrorBox;
  // Credits are behind a separate launch flag. When off, don't show any
  // credit-specific CTA/copy.
  if (!creditsUiEnabled) return plainErrorBox;
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
