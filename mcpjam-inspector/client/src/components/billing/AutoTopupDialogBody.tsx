import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useAutoTopup, type AutoTopupSetup } from "@/hooks/useAutoTopup";
import { AutoTopupSettings } from "./AutoTopupSettings";
import { AutoTopupCardSetup } from "./AutoTopupCardSetup";
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
  const { view, querySkipped, save, disable, clear, begin, finish } =
    useAutoTopup(organizationId);
  const [setup, setSetup] = useState<AutoTopupSetup | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "";
  const cardSetupConfigured = /^pk_(test|live)_/.test(publishableKey);
  if (querySkipped)
    return (
      <p role="status" className="text-sm">
        Sign in to view organization refill settings.
      </p>
    );
  if (setup && canManage)
    return (
      <AutoTopupCardSetup
        setup={setup}
        publishableKey={publishableKey}
        onFinish={async (id) => {
          await finish(id);
          if (mounted.current) setSetup(null);
        }}
        onCancel={() => setSetup(null)}
      />
    );
  return (
    <>
      {turnedOff && (
        <p role="status" className="text-sm">
          New automatic purchases are off. Saved settings remain;
          already-authorized payments can still complete.
        </p>
      )}
      <AutoTopupSettings
        key={
          view
            ? `${view.revision}:${view.refillPriceCents}:${view.activationAllowed}`
            : "loading"
        }
        view={view}
        canManage={canManage}
        cardSetupConfigured={cardSetupConfigured}
        onSave={async (configuration) => {
          await save(configuration);
          if (mounted.current) setTurnedOff(false);
        }}
        onDisable={async () => {
          await disable();
          if (mounted.current) setTurnedOff(true);
        }}
        onClear={async () => {
          await clear();
          if (mounted.current) setTurnedOff(false);
        }}
        onClose={onClose}
        onBegin={
          cardSetupConfigured
            ? async () => {
                setTurnedOff(false);
                const next = await begin();
                if (mounted.current) setSetup(next);
              }
            : undefined
        }
      />
    </>
  );
}
export function AutoTopupDialogBody(props: AutoTopupDialogBodyProps) {
  return (
    <ErrorBoundary
      key={props.organizationId}
      name="credit_balance_auto_topup"
      fallback={
        <p role="status" className="text-sm">
          Auto-reload is unavailable right now. Please try again later.
        </p>
      }
    >
      <ConnectedAutoTopupSettings {...props} />
    </ErrorBoundary>
  );
}

/** The auto-reload settings dialog, opened from billing and from refusals. */
export function AutoTopupDialog({
  open,
  onOpenChange,
  organizationId,
  canManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId?: string | null;
  canManage: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Auto-reload</DialogTitle>
          <DialogDescription>
            Automatically purchase credits when you’re running low.
          </DialogDescription>
        </DialogHeader>
        <AutoTopupDialogBody
          organizationId={organizationId}
          canManage={canManage}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
