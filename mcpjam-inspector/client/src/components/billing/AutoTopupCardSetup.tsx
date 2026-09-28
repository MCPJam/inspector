import { useEffect, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  mountAutoTopupCard,
  type AutoTopupCardSession,
} from "@/lib/auto-topup-stripe";
import type { AutoTopupSetup } from "@/hooks/useAutoTopup";
import { messageOf } from "@/hooks/useOrgScopedWrite";
export function AutoTopupCardSetup({
  setup,
  publishableKey,
  onFinish,
  onCancel,
}: {
  setup: AutoTopupSetup;
  publishableKey: string;
  onFinish: (id: string) => Promise<void>;
  onCancel: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<AutoTopupCardSession | null>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const confirmedSetup = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    void mountAutoTopupCard(publishableKey, container.current!)
      .then((card) => {
        if (disposed) {
          card.destroy();
          return;
        }
        session.current = card;
        setReady(true);
      })
      .catch((cause) => {
        if (!disposed) setError(messageOf(cause));
      });
    return () => {
      disposed = true;
      mounted.current = false;
      session.current?.destroy();
      session.current = null;
    };
  }, [publishableKey]);
  const confirm = async () => {
    if (!session.current || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (confirmedSetup.current !== setup.setupIntentId) {
        await session.current.confirm(setup.clientSecret, setup.setupIntentId);
        confirmedSetup.current = setup.setupIntentId;
      }
      if (mounted.current) await onFinish(setup.setupIntentId);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Save a card for the automatic purchases you authorized. Enrollment may
        immediately trigger a refill if your balance is low.
      </p>
      <div
        ref={container}
        aria-label="Secure card details"
        className="rounded-md border border-input bg-background p-4"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={!ready || busy} onClick={() => void confirm()}>
        {busy ? "Confirming…" : "Save card and enable refills"}
      </Button>
      <Button variant="outline" disabled={busy} onClick={onCancel}>
        Back to settings
      </Button>
    </div>
  );
}
