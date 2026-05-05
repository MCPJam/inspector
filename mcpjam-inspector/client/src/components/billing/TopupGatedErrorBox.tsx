import type { ComponentProps } from "react";

import { ErrorBox } from "@/components/chat-v2/error";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditTopupPresets } from "@/hooks/useCreditTopup";

type ErrorBoxProps = ComponentProps<typeof ErrorBox>;

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

export function TopupGatedErrorBox(props: ErrorBoxProps) {
  const plainErrorBox = (
    <ErrorBox {...props} canTopUp={false} onTopUp={undefined} />
  );
  if (props.canTopUp !== true) return plainErrorBox;
  return (
    <ErrorBoundary fallback={plainErrorBox}>
      <GatedInner {...props} />
    </ErrorBoundary>
  );
}
