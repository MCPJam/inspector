import { Button } from "@mcpjam/design-system/button";
import { useCreditTopupPresets } from "@/hooks/useCreditTopup";

interface TopupActionButtonProps {
  onClick: () => void;
}

/**
 * Renders the "Buy credits" button only when the credit package endpoint has
 * resolved with at least one preset. Avoids the dead-end UX where clicking
 * the button opens a dialog that immediately shows "Credit packages are
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
      Buy credits
    </Button>
  );
}
