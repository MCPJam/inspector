import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@mcpjam/design-system/button";
import type { PlatformDeletionReceipt } from "@mcpjam/sdk/platform";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { cancelDeletion, readDeletion, recoverDeletion } from "@/lib/apis/deletion-api";

function time(value: number | null): string | null {
  return value === null ? null : new Date(value).toLocaleString();
}

export function DeletionStatusRoute() {
  const { requestId = "" } = useParams();
  const navigate = useNavigate();
  const { getAccessToken, isLoading, user, signIn } = useAuth();
  const [receipt, setReceipt] = useState<PlatformDeletionReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const next = await (requestId === "pending"
        ? recoverDeletion(window.location.search, getAccessToken)
        : readDeletion(requestId, getAccessToken));
      setReceipt(next);
      if (requestId === "pending") {
        navigate(`/deletions/${encodeURIComponent(next.requestId)}`, { replace: true });
      }
    } catch {
      setFailed(true);
      setReceipt(null);
    } finally {
      setLoading(false);
    }
  }, [requestId, getAccessToken, navigate]);

  useEffect(() => {
    if (!isLoading && user) void refresh();
  }, [refresh, isLoading, user]);

  const cancel = async () => {
    if (!receipt?.canCancel || acting) return;
    setActing(true);
    setCancelFailed(false);
    try {
      setReceipt(await cancelDeletion(receipt.requestId, getAccessToken));
    } catch {
      await refresh();
      setCancelFailed(true);
    } finally {
      setActing(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-12 text-foreground">
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">
          Deletion request
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Deletion status</h1>
        {isLoading ? (
          <p className="mt-5 text-sm text-muted-foreground" role="status">
            Checking sign-in…
          </p>
        ) : !user ? (
          <SignInNotice signIn={() => void signIn(permalinkSignInOptions())} />
        ) : loading ? (
          <p className="mt-5 text-sm text-muted-foreground" role="status">
            {requestId === "pending" ? "Checking deletion request…" : "Loading request status…"}
          </p>
        ) : failed || !receipt ? (
          <div className="mt-5 space-y-4">
            <p className="text-sm text-muted-foreground">
              We couldn’t verify this request. Sign in with an authorized
              account and try again.
            </p>
            <Button variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : (
          <DeletionReceipt
            receipt={receipt}
            acting={acting}
            cancelFailed={cancelFailed}
            refresh={refresh}
            cancel={cancel}
          />
        )}
      </section>
    </main>
  );
}

function DeletionReceipt({
  receipt,
  acting,
  cancelFailed,
  refresh,
  cancel,
}: {
  receipt: PlatformDeletionReceipt;
  acting: boolean;
  cancelFailed: boolean;
  refresh: () => Promise<void>;
  cancel: () => Promise<void>;
}) {
  return (
    <div className="mt-5 space-y-5">
      <ReceiptSummary receipt={receipt} />
      {receipt.state === "cancel_pending" && (
        <p className="text-sm text-muted-foreground" role="status">
          Cancellation is being recorded. Access remains paused until
          confirmation.
        </p>
      )}
      {receipt.state === "cancelled" && (
        <p className="text-sm text-muted-foreground" role="status">
          Deletion was cancelled. Scheduled work remains paused and must be
          resumed explicitly.
        </p>
      )}
      {cancelFailed && (
        <p className="text-sm text-destructive" role="alert">
          Cancellation could not be confirmed. Refresh status to check this
          request.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void refresh()}
          disabled={acting}
        >
          Refresh status
        </Button>
        {receipt.canCancel && (
          <Button
            variant="destructive"
            onClick={() => void cancel()}
            disabled={acting}
          >
            {acting ? "Requesting cancellation…" : "Cancel deletion"}
          </Button>
        )}
      </div>
    </div>
  );
}

function SignInNotice({ signIn }: { signIn: () => void }) {
  return (
    <div className="mt-5 space-y-4">
      <p className="text-sm">Sign in to view this deletion request.</p>
      <Button onClick={signIn}>Sign in</Button>
    </div>
  );
}

function ReceiptSummary({ receipt }: { receipt: PlatformDeletionReceipt }) {
  return (
    <div className="rounded-md bg-muted p-4 text-sm">
      <p>
        <span className="font-medium">Scope:</span> {receipt.scope.type}
      </p>
      <p className="mt-1 break-all">
        <span className="font-medium">Reference:</span> {receipt.scope.id}
      </p>
      <p className="mt-1">
        <span className="font-medium">Status:</span>{" "}
        {receipt.state.replaceAll("_", " ")}
      </p>
      <p className="mt-1">
        <span className="font-medium">Accepted:</span>{" "}
        {time(receipt.acceptedAt)}
      </p>
      {receipt.purgeAfter !== null && (
        <p className="mt-1">
          <span className="font-medium">Cancellation window ends:</span>{" "}
          {time(receipt.purgeAfter)}
        </p>
      )}
      {receipt.liveDataDeletedAt !== null && (
        <p className="mt-1">
          <span className="font-medium">Live data removed:</span>{" "}
          {time(receipt.liveDataDeletedAt)}
        </p>
      )}
      {receipt.closedAt !== null && (
        <p className="mt-1">
          <span className="font-medium">Closed:</span> {time(receipt.closedAt)}
        </p>
      )}
      {receipt.attentionCode !== null && (
        <p className="mt-1 text-destructive">
          <span className="font-medium">Needs staff attention:</span>{" "}
          {receipt.attentionCode}
        </p>
      )}
    </div>
  );
}
