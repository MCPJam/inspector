import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useAutoTopup } from "@/hooks/useAutoTopup";
import { AutoTopupSettings } from "./AutoTopupSettings";

interface AutoTopupDialogBodyProps {
  organizationId?: string | null;
  canManage: boolean;
  onClose: () => void;
}

function ConnectedAutoTopupSettings({
  organizationId,
  canManage,
  onClose,
}: AutoTopupDialogBodyProps) {
  const { enrollment, querySkipped, save, disable } =
    useAutoTopup(organizationId);
  if (querySkipped) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Auto-reload is available for team organizations.
      </p>
    );
  }
  return (
    <AutoTopupSettings
      enrollment={enrollment}
      canManage={canManage}
      onSave={save}
      onDisable={disable}
      onClose={onClose}
    />
  );
}

/**
 * The auto-reload dialog contents, with the enrollment query fenced off so a
 * backend that has not shipped the function yet degrades to a message
 * instead of taking the whole balance card down.
 */
export function AutoTopupDialogBody(props: AutoTopupDialogBodyProps) {
  return (
    <ErrorBoundary
      name="credit_balance_auto_topup"
      fallback={
        <p className="text-sm text-muted-foreground" role="status">
          Auto-reload is unavailable right now. Please try again later.
        </p>
      }
    >
      <ConnectedAutoTopupSettings {...props} />
    </ErrorBoundary>
  );
}
