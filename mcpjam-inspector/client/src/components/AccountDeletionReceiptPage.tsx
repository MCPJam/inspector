import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  AccountDeletionClient,
  type AccountDeletionReceipt,
} from "@mcpjam/sdk/account-deletion";
import {
  loadAccountDeletion,
  clearActiveAccountDeletion,
} from "@/lib/account-deletion-storage";

export function isAccountReceiptPath(path: string): boolean {
  return /^\/account-deletion\/receipt\/[a-f0-9-]{36}$/.test(path);
}
function label(receipt: AccountDeletionReceipt): string {
  if (
    receipt.state === "closed" &&
    receipt.closedAt !== null &&
    receipt.liveDataDeletedAt !== null
  )
    return "Deletion completed";
  if (
    receipt.state === "live_data_deleted" &&
    receipt.liveDataDeletedAt !== null
  )
    return "Live data deletion verified";
  if (receipt.state === "needs_attention") return "Deletion needs attention";
  if (receipt.state === "verifying") return "Checking deletion";
  if (receipt.state === "deleting") return "Deletion in progress";
  return "Deletion started";
}
function useAccountDeletionReceipt(localId: string) {
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  async function refresh() {
    setLoading(true);
    setMessage("");
    try {
      const pending = await loadAccountDeletion(localId);
      if (!pending) {
        setReceipt(null);
        setMessage(
          "This browser has no recovery record for this request. Contact support.",
        );
        return;
      }
      const client = new AccountDeletionClient({
        baseUrl: "/api/web/account-deletion",
        authenticatedFetch: fetch,
      });
      const result = await client.receipt({
        receiptSecret: pending.receiptSecret,
        idempotencyKey: pending.idempotencyKey,
      });
      setReceipt(result);
      if (!result)
        setMessage(
          "This request could not be verified. Receipt access may have expired. Keep this recovery record and contact support.",
        );
    } catch {
      setMessage(
        "The receipt could not be checked. Keep this recovery record and try again.",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [localId]);
  return { receipt, loading, message, refresh };
}
function AccountReceiptDetails({
  receipt,
}: {
  receipt: AccountDeletionReceipt;
}) {
  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="text-muted-foreground">Request</dt>
        <dd className="break-all font-mono">{receipt.requestId}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Accepted</dt>
        <dd>{new Date(receipt.acceptedAt).toLocaleString()}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Live data deletion due</dt>
        <dd>{new Date(receipt.dueAt).toLocaleString()}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Request recorded</dt>
        <dd>
          {receipt.journalConfirmedAt === null
            ? "Pending"
            : new Date(receipt.journalConfirmedAt).toLocaleString()}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Live data deletion verified</dt>
        <dd>
          {receipt.liveDataDeletedAt === null
            ? "Pending"
            : new Date(receipt.liveDataDeletedAt).toLocaleString()}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Final closure</dt>
        <dd>
          {receipt.closedAt === null
            ? "Pending"
            : new Date(receipt.closedAt).toLocaleString()}
        </dd>
      </div>
    </dl>
  );
}
export function AccountDeletionReceiptPage({
  localId = window.location.pathname.split("/").at(-1) ?? "",
}: {
  localId?: string;
}) {
  const { receipt, loading, message, refresh } =
    useAccountDeletionReceipt(localId);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-12 text-foreground">
      <section className="space-y-5 rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          Account deletion receipt
        </p>
        <h1 className="text-2xl font-semibold">
          {loading
            ? "Checking deletion request"
            : receipt
              ? label(receipt)
              : "Deletion status unavailable"}
        </h1>
        {message && (
          <p role="alert" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
        {receipt && <AccountReceiptDetails receipt={receipt} />}
        <p className="text-sm text-muted-foreground">
          This receipt does not provide account access. The request cannot be
          cancelled. Keep this browser’s recovery record to check progress.
        </p>
        <div className="flex gap-3">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Refresh status
          </Button>
          <a
            className="self-center text-sm underline"
            href="/"
            onClick={() => clearActiveAccountDeletion(localId)}
          >
            Return to MCPJam
          </a>
        </div>
      </section>
    </main>
  );
}
