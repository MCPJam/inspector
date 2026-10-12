import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "@mcpjam/design-system/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { endOrganizationDeletion } from "@/stores/organization-deletion-store";
import { toast } from "@/lib/toast";
import { isConvexQueryUnavailable, convexErrMessage } from "@/lib/convex-error";

type PendingDeletion = {
  organizationId: string;
  name: string;
  purgeAfter: number;
};
const pendingRef = makeFunctionReference<
  "query",
  Record<string, never>,
  PendingDeletion[]
>("organizations:getMyPendingOrganizationDeletions");
const cancelRef = makeFunctionReference<
  "mutation",
  { organizationId: string },
  { success: boolean }
>("organizations:cancelOrganizationDeletion");

export function PendingOrganizationDeletions() {
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => {
      setFailed(false);
      setRetry((value) => value + 1);
    }, Math.min(30_000 * 2 ** retry, 300_000));
    return () => clearTimeout(timer);
  }, [failed, retry]);
  return (
    <ErrorBoundary key={retry} name="pending_organization_deletions" fallback={null}
      isExpectedError={isConvexQueryUnavailable} onError={() => setFailed(true)}>
      <PendingDeletionBanner />
    </ErrorBoundary>
  );
}

function PendingDeletionBanner() {
  const { isAuthenticated } = useConvexAuth();
  const ready = useDbUserReady();
  const pending = useQuery(pendingRef, isAuthenticated && ready ? {} : "skip");
  const cancel = useMutation(cancelRef);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const next = pending?.map((item) => item.purgeAfter).filter((deadline) => deadline > now).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - now + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [pending, now]);
  const cancelDeletion = async (organizationId: string) => {
    setCancelling(organizationId);
    try {
      await cancel({ organizationId });
      endOrganizationDeletion(organizationId);
      toast.success("Organization deletion cancelled");
    } catch (error) {
      setNow(Date.now());
      toast.error(
        convexErrMessage(error, "Could not cancel organization deletion. Try again."),
      );
    } finally {
      setCancelling(null);
    }
  };
  if (!pending?.length) return null;
  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      {pending.map((item) => (
        <Alert key={item.organizationId}>
          <AlertTitle>Deletion scheduled for {item.name}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {now >= item.purgeAfter ? "Deletion is in progress." : `You can cancel until ${new Date(item.purgeAfter).toLocaleString()}.`}
              Members cannot access this organization while deletion is pending.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={cancelling !== null || now >= item.purgeAfter}
              onClick={() => void cancelDeletion(item.organizationId)}
            >
              {cancelling === item.organizationId
                ? "Cancelling…"
                : "Cancel deletion"}
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
