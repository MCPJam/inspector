import { Button } from "@mcpjam/design-system/button";
import { useCreditTopupPresets } from "@/hooks/useCreditTopup";

interface TopupActionButtonProps {
  onClick: () => void;
}

/**
 * Renders the "Top up" button only when the topup preset endpoint has
 * resolved with at least one preset. Avoids the dead-end UX where clicking
 * the button opens a dialog that immediately shows "Top-up amounts are
 * unavailable right now" because the backend is missing the function.
 *
 * Wrap this in an `<ErrorBoundary fallback={null}>` at the call site so a
 * thrown query (e.g. function not deployed) collapses to nothing instead of
 * surfacing a generic error UI.
 */
export function TopupActionButton({ onClick }: TopupActionButtonProps) {
  const { presets } = useCreditTopupPresets();
  if (!presets || presets.length === 0) return null;
  return (
    <Button type="button" size="sm" onClick={onClick}>
      Top up
    </Button>
  );
}
